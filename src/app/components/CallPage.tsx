/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import "@/app/styles/Call.css";
import { useEffect, useRef, useState, useCallback } from "react";
import * as CallinkModule from "callink";
import  createLink  from "@/app/services/sendiu-callink-api";
import { IconButton, Tooltip, Chip, Divider, Button, CircularProgress } from "@mui/material";
import {
    Mic as MicIcon,
    MicOff as MicOffIcon,
    FiberManualRecord as FiberManualRecordIcon,
    Stop as StopIcon,
    Call as CallIcon,
    CallEnd as CallEndIcon,
    Link as LinkIcon,
    ContentCopy as ContentCopyIcon,
    Check as CheckIcon,
    PhoneCallback as PhoneCallbackIcon,
    Replay as ReplayIcon,
} from "@mui/icons-material";

const Callink = (CallinkModule as any).default || (CallinkModule as any);

// ── Types ─────────────────────────────────────────────────────────────────────

type CallStatus =
    | "idle"        // sin hacer nada, estado inicial
    | "generating"  // generando el enlace
    | "connecting"  // conectando al servidor
    | "connected"   // conectado, listo para llamar
    | "ringing"     // llamando, esperando que el receptor conteste
    | "inCall"     // llamada activa
    | "ended"       // llamada terminada
    | "error";      // error de conexión

interface Toast {
    id: string;
    message: string;
    type: "success" | "error" | "info" | "warning";
    icon: string;
}

interface Props {
    initialToken?: string;
}

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<CallStatus, { label: string; color: string }> = {
    idle: { label: "Listo", color: "#64748b" },
    generating: { label: "Generando enlace...", color: "#f59e0b" },
    connecting: { label: "Conectando...", color: "#f59e0b" },
    connected: { label: "Conectado", color: "#10b981" },
    ringing: { label: "Llamando...", color: "#f59e0b" },
    inCall: { label: "En llamada", color: "#10b981" },
    ended: { label: "Llamada terminada", color: "#64748b" },
    error: { label: "Error de conexión", color: "#ef4444" },
};

//bloquear el botón llamar hasta que el usuario haga reset
const BUSY_STATUSES: CallStatus[] = ["generating", "connecting", "ringing", "inCall", "ended"];

//no bloquear el botón reset de colgar si esta en uno de estos estados
const BUSY_HANG: CallStatus[] = [ "inCall", "connecting", "ringing"];

// ── Hold Music ────────────────────────────────────────────────────────────────
const HOLD_MUSIC_OPTIONS = [
    { label: "🎵 Melodía Suave", url: "https://dl.espressif.com/dl/audio/ff-16b-2c-44100hz.mp3" },
    { label: "🎸 Ritmo Ligero", url: "https://dl.espressif.com/dl/audio/ff-16b-2c-22050hz.mp3" },
    { label: "🎺 Ambiente Tranquilo", url: "https://dl.espressif.com/dl/audio/ff-16b-2c-16000hz.mp3" },
    // { label: "🎹 Interludio Breve", url: "https://dl.espressif.com/dl/audio/gs-16b-2c-44100hz.mp3" },
];

// ─────────────────────────────────────────────────────────────────────────────

export default function CallPage({ initialToken }: Props) {
    const isReceiver = !!initialToken;

    // refs
    const callinkRef = useRef<any>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const ringAudioRef = useRef<HTMLAudioElement | null>(null); // audio de tono de llamada
    const analyserRef = useRef<AnalyserNode | null>(null);
    const animRef = useRef<number | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const waveAnimRef = useRef<number | null>(null);
    const durationRef = useRef<NodeJS.Timeout | null>(null);
    const wasInCallRef = useRef(false);
    // FIX: ref para el timer de onDisconnected — evita terminar la llamada durante reconexión de WebSocket
    const disconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

    // state
    const [generatedToken, setGeneratedToken] = useState("");
    const [generatedLink, setGeneratedLink] = useState("");
    const [status, setStatus] = useState<CallStatus>("idle");
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [volume, setVolume] = useState(0);
    const [callDuration, setCallDuration] = useState(0);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [copied, setCopied] = useState<"link" | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [selectedMusic, setSelectedMusic] = useState(HOLD_MUSIC_OPTIONS[0].url);
    const [isResetting, setIsResetting] = useState(false);
    const [clientID] = useState(() => crypto.randomUUID());

    const isInCall = status === "inCall";
    const showControls = isInCall;

    // ── Init ──────────────────────────────────────────────────────────────────

    useEffect(() => {
        if (status !== "inCall") {
            setIsMuted(false);
            setIsRecording(false);
        }
    }, [status]);

    // El receptor inicializa automáticamente al montar
    useEffect(() => {
        if (isReceiver) {
            initializeCallink(initialToken!);
        }
    }, []);

    // FIX: Destroy() en lugar de dispose() — dispose() no existe en la librería,
    // la instancia anterior quedaba viva con su WebSocket abierto
    useEffect(() => {
        return () => {
            if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
            callinkRef.current?.Destroy?.();
            callinkRef.current = null;
        };
    }, []);

    // ── Toast ─────────────────────────────────────────────────────────────────

    const showToast = useCallback((message: string, type: Toast["type"], icon: string) => {
        const id = crypto.randomUUID();
        setToasts(prev => [...prev, { id, message, type, icon }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
    }, []);

    const removeToast = (id: string) =>
        setToasts(prev => prev.filter(t => t.id !== id));

    // ── Wave canvas ───────────────────────────────────────────────────────────

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        let tick = 0;

        const draw = () => {
            canvas.width = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const waves = isSpeaking ? 4 : 2;
            const amp = isSpeaking ? 18 + volume * 0.4 : 5;
            for (let w = 0; w < waves; w++) {
                ctx.beginPath();
                const opacity = isSpeaking ? 0.4 - w * 0.08 : 0.12 - w * 0.02;
                ctx.strokeStyle = `hsla(${isSpeaking ? 142 : 210}, 80%, 60%, ${opacity})`;
                ctx.lineWidth = 2;
                for (let x = 0; x <= canvas.width; x++) {
                    const y = canvas.height / 2
                        + Math.sin(x * (0.012 + w * 0.004) + tick * (0.03 + w * 0.01))
                        * amp * (1 - w * 0.2);
                    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            tick++;
            waveAnimRef.current = requestAnimationFrame(draw);
        };

        draw();
        return () => { if (waveAnimRef.current) cancelAnimationFrame(waveAnimRef.current); };
    }, [isSpeaking, volume]);

    // ── Duration timer ────────────────────────────────────────────────────────

    useEffect(() => {
        if (status === "inCall") {
            setCallDuration(0);
            durationRef.current = setInterval(() => setCallDuration(p => p + 1), 1000);
        } else {
            if (durationRef.current) clearInterval(durationRef.current);
            setCallDuration(0);
        }
        return () => { if (durationRef.current) clearInterval(durationRef.current); };
    }, [status]);

    const formatDuration = (s: number) =>
        `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

    // ── Ringtone ──────────────────────────────────────────────────────────────

    const startRinging = () => {
        if (!ringAudioRef.current) return;
        ringAudioRef.current.loop = true;
        ringAudioRef.current.play().catch(console.error);
    };

    const stopRinging = () => {
        if (!ringAudioRef.current) return;
        ringAudioRef.current.pause();
        ringAudioRef.current.currentTime = 0;
    };

    // ── Audio ─────────────────────────────────────────────────────────────────

    const cleanupAudio = () => {
        stopRinging();
        if (audioRef.current) {
            (audioRef.current.srcObject as MediaStream | null)
                ?.getTracks().forEach(tr => tr.stop());
            audioRef.current.pause();
            audioRef.current.srcObject = null;
        }
        if (animRef.current) { cancelAnimationFrame(animRef.current); animRef.current = null; }
        analyserRef.current = null;
        setIsSpeaking(false);
        setVolume(0);
    };

    const startAudioAnalysis = (stream: MediaStream) => {
        const actx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const source = actx.createMediaStreamSource(stream);
        const analyser = actx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analyserRef.current = analyser;
        const data = new Uint8Array(analyser.frequencyBinCount);
        const detect = () => {
            if (!analyserRef.current) return;
            analyserRef.current.getByteFrequencyData(data);
            const avg = data.reduce((a, b) => a + b, 0) / data.length;
            setVolume(avg);
            setIsSpeaking(avg > 15);
            animRef.current = requestAnimationFrame(detect);
        };
        detect();
    };

    // ── Callink API ───────────────────────────────────────────────────────────

    const initializeCallink = async (token: string) => {
        // FIX: Destroy() en lugar de dispose() que no existe en la librería
        await callinkRef.current?.Destroy?.();
        callinkRef.current = null;
        wasInCallRef.current = false;
        setStatus("connecting");

        callinkRef.current = new Callink({
            SignalingWebsocketURL: "wss://callink-signaling-0-dev.sendiu.net",
            ApiURL: "https://sendiu-callink-dev.sendiu.net",
            Token: token,
            Debug: true,
            Keycloak: undefined,
            TenantId: undefined,
            Callbacks: {
                // Se dispara cuando se establece la conexión con el servidor, pero antes de iniciar cualquier llamada
                onConnected: () => {
                    setStatus("connected");
                },
                 // Se dispara cuando alguno se une a la llamada y espera que el otro se una
                onRinging: () => {
                    setStatus("ringing");
                    startRinging();
                },
                // Se dispara cuando ambos participantes se han unido a la llamada y está activa
                onOpen: () => {
                    stopRinging();
                    setStatus("inCall");
                },
                // Se dispara cuando alguno contesta y se activa el stream de audio
                onStream: (stream: MediaStream) => {
                    wasInCallRef.current = true;
                    setStatus("inCall");
                    startAudioAnalysis(stream);
                },
                // Se dispara cada vez que llega una nueva pista de audio
                onTrack: (event: RTCTrackEvent) => {
                    if (event.track.kind !== "audio") return;
                    if (audioRef.current) {
                        audioRef.current.srcObject = new MediaStream([event.track]);
                        audioRef.current.play().catch(console.error);
                    }
                },
                // FIX: onDisconnected también se dispara durante reconexión automática del WebSocket.
                // Se agrega delay de 4s para dar tiempo a la reconexión antes de terminar la llamada.
                onDisconnected: () => {
                    if (!wasInCallRef.current) return;
                    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
                    disconnectTimerRef.current = setTimeout(() => {
                        if (callinkRef.current?.callService?.HasActiveCall?.()) return;
                        if (!wasInCallRef.current) return;
                        wasInCallRef.current = false;
                        setStatus("ended");
                        showToast("La sesión ha expirado", "warning", "⌛");
                        cleanupAudio();
                    }, 4000);
                },
                // Se dispara cuando la llamada se termina por uno de los participantes — cancela el timer
                onClosed: () => {
                    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
                    if (!wasInCallRef.current) return;
                    wasInCallRef.current = false;
                    setStatus("ended");
                    showToast("El otro participante colgó", "warning", "📴");
                    cleanupAudio();
                },
                // Se dispara cuando alguno se une pero el otro no responde a tiempo
                onNoAnswer: () => {
                    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
                    stopRinging();
                    wasInCallRef.current = false;
                    setStatus("ended");
                    showToast("Llamada sin respuesta", "warning", "⏱️");
                    cleanupAudio();
                },
            },
        });
    };

    // ── Actions ───────────────────────────────────────────────────────────────

    // El emisor genera un nuevo enlace y token al hacer click
    const handleCreateCallLink = async () => {
        try {
            setStatus("generating");
            showToast("Generando enlace seguro...", "info", "🔐");
            const response = await createLink();
            const token = response?.token;
            if (!token) throw new Error("Token inválido");
            const link = `${window.location.origin}/${token}`;
            setGeneratedToken(token);
            setGeneratedLink(link);
            await initializeCallink(token);
        } catch {
            setStatus("error");
            showToast("Error generando el enlace", "error", "❌");
        }
    };

    // El emisor puede resetear todo para generar un nuevo enlace
    const handleReset = async () => {
        setIsResetting(true);
        if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
        // FIX: Destroy() en lugar de dispose()
        await callinkRef.current?.Destroy?.();
        callinkRef.current = null;
        wasInCallRef.current = false;
        cleanupAudio();
        setGeneratedToken("");
        setGeneratedLink("");
        setCallDuration(0);
        setIsMuted(false);
        setIsRecording(false);
        await handleCreateCallLink();
        setIsResetting(false);
    };

    // Tanto el emisor como el receptor pueden iniciar la llamada
    const handleStartCall = async () => {
        const token = initialToken || generatedToken;

        if (!token) {
            showToast("No hay token disponible", "warning", "⚠️");
            return;
        }

        if (!callinkRef.current) {
            showToast("Aún conectando, intenta de nuevo", "warning", "⚠️");
            return;
        }

        try {
            await callinkRef.current.Call(clientID, token);
            showToast(
                isReceiver ? "Te uniste a la llamada" : "Llamando...",
                "info",
                "📲"
            );
        } catch (error: any) {
            if (error?.name === "NotAllowedError") {
                showToast("Debes permitir el micrófono para realizar la llamada", "error", "🎤");
                return;
            }
            if (error?.name === "NotFoundError") {
                showToast("No se detectó ningún micrófono en el dispositivo", "error", "🎤");
                return;
            }
        }
    };

    // Colgar la llamada
    const handleHangUp = async () => {
        if (!callinkRef.current) return;
        if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
        stopRinging();
        wasInCallRef.current = false;
        try { await callinkRef.current.HangUp(); } catch (_) { }
        // FIX: Destroy() en lugar de dispose()
        await callinkRef.current?.Destroy?.();
        callinkRef.current = null;
        setStatus("ended");
        showToast("Llamada finalizada", "info", "👋");
        cleanupAudio();
    };

    // Silenciar el micrófono, también reproduce música de espera para el otro participante
    const handleToggleMute = () => {
        if (!callinkRef.current) return;
        if (isMuted) {
            callinkRef.current.Unmute();
            callinkRef.current.StopAudio();
            setIsMuted(false);
            showToast("Micrófono activado", "info", "🎤");
        } else {
            callinkRef.current.Mute();
            callinkRef.current.PlayAudio(selectedMusic, true);
            setIsMuted(true);
            showToast("Micrófono silenciado", "warning", "🔇");
        }
    };

    // Grabar la llamada
    const handleToggleRecord = () => {
        if (!callinkRef.current) return;
        if (isRecording) {
            callinkRef.current.StopRecording();
            setIsRecording(false);
            showToast("Grabación detenida", "info", "⏹️");
        } else {
            callinkRef.current.StartRecording();
            setIsRecording(true);
            showToast("Grabación iniciada", "success", "⏺️");
        }
    };

    // Copiar al portapapeles
    const copyToClipboard = async (text: string) => {
        await navigator.clipboard.writeText(text);
        setCopied("link");
        showToast("Link copiado", "success", "📋");
        setTimeout(() => setCopied(null), 2000);
    };

    // ── Derived ───────────────────────────────────────────────────────────────

    const sc = STATUS_CONFIG[status];
    const waveClass = isMuted ? "muted" : isSpeaking ? "speaking" : "";
    const pulsingStatuses: CallStatus[] = ["generating", "connecting", "ringing", "inCall"];

    return (
        <>

        <h1>fixed testing</h1>
            {/* Audio de la llamada */}
            <audio ref={audioRef} autoPlay playsInline className="hidden" />

            {/* Audio del tono de llamada */}
            <audio
                ref={ringAudioRef}
                src="https://dl.espressif.com/dl/audio/gs-16b-2c-44100hz.mp3"
                preload="auto"
                className="hidden"
            />

            {/* ── Toasts ── */}
            <div className="toast-list">
                {toasts.map(toast => (
                    <div
                        key={toast.id}
                        className={`toast-item ${toast.type}`}
                        onClick={() => removeToast(toast.id)}
                    >
                        <span>{toast.icon}</span>
                        {toast.message}
                    </div>
                ))}
            </div>

            {/* ── Page ── */}
            <div className="min-h-screen flex items-center justify-center">
                <div className="call-bg-grid" />

                <div className="call-card">

                    {/* ════════════════════════════════
                        Header
                    ════════════════════════════════ */}
                    <div className="
                        flex items-center justify-between gap-4
                        px-8 pt-7 pb-5
                        border-b border-slate-200 dark:border-white/5
                    ">
                        <div className="flex items-center gap-3">
                            <div
                                className="w-10 h-10 rounded-xl flex items-center justify-center text-lg"
                                style={{
                                    background: "linear-gradient(135deg,#3b82f6,#1d4ed8)",
                                    boxShadow: "0 4px 20px rgba(59,130,246,0.4)",
                                }}
                            >
                                📞
                            </div>
                            <div>
                                <p className="text-sm font-semibold tracking-tight text-slate-800 dark:text-slate-200">
                                    Botpro
                                </p>
                                <p className="text-[0.7rem] text-slate-400 dark:text-slate-500">
                                    Tiempo Real · P2P
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            {isRecording && (
                                <div className="rec-indicator">
                                    <div className="rec-dot" />
                                    REC
                                </div>
                            )}

                            <Chip
                                label={isReceiver ? "Receptor" : "Emisor"}
                                size="small"
                                className="chip-sender"
                                sx={{
                                    fontSize: "0.65rem",
                                    fontWeight: 700,
                                    letterSpacing: "0.08em",
                                    borderRadius: "100px",
                                    height: 30,
                                }}
                            />

                            <div className="
                                flex items-center gap-1.5 px-3 py-1.5 rounded-full
                                border border-slate-200 bg-slate-100
                                dark:border-white/10 dark:bg-slate-800/60
                            ">
                                <div
                                    className={`status-dot ${pulsingStatuses.includes(status) ? "pulse" : ""}`}
                                    style={{ background: sc.color }}
                                />
                                <span
                                    className="text-[0.72rem] font-medium font-mono"
                                    style={{ color: sc.color }}
                                >
                                    {status === "inCall"
                                        ? `${sc.label} · ${formatDuration(callDuration)}`
                                        : sc.label}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* ════════════════════════════════
                        Body
                    ════════════════════════════════ */}
                    <div className="flex flex-col gap-6 px-8 pt-6 pb-8">

                        {/* Wave visualizer */}
                        <div className={`wave-container ${waveClass}`}>
                            <canvas ref={canvasRef} />
                            <span className="wave-label">
                                {isMuted
                                    ? "🔇 Silenciado"
                                    : isInCall
                                        ? isSpeaking ? "🎤 Hablando" : "Silencio"
                                        : status === "ringing"
                                            ? "📳 Llamando..."
                                            : "Sin audio activo"}
                            </span>
                        </div>

                        {/* ── Controls bar ── */}
                        {showControls && (
                            <div className="controls-bar">

                                {/* Mute */}
                                <div className="ctrl-btn-wrap">
                                    <Tooltip title={isMuted ? "Activar micrófono" : "Silenciar micrófono"} placement="top">
                                        <div className={`ctrl-icon-box ${isMuted ? "mute-active" : ""}`}>
                                            <IconButton
                                                onClick={handleToggleMute}
                                                size="small"
                                                className={isMuted ? "icon-mute-active" : "icon-default"}
                                                sx={{ "&:hover": { bgcolor: "transparent" } }}
                                            >
                                                {isMuted ? <MicOffIcon fontSize="small" /> : <MicIcon fontSize="small" />}
                                            </IconButton>
                                        </div>
                                    </Tooltip>
                                    <span className={`ctrl-label ${isMuted ? "mute-on" : ""}`}>
                                        {isMuted ? "Silenciado" : "Micrófono"}
                                    </span>
                                </div>

                                <div className="controls-sep" />

                                {/* Selector de música en espera */}
                                <div className="ctrl-btn-wrap">
                                    <select
                                        value={selectedMusic}
                                        onChange={e => setSelectedMusic(e.target.value)}
                                        className="
                                            text-[0.72rem] font-medium rounded-xl px-3 py-2
                                            outline-none cursor-pointer
                                            bg-slate-100 border border-slate-200 text-slate-700
                                            dark:bg-slate-800/60 dark:border-slate-700/50 dark:text-slate-300
                                        "
                                        style={{ maxWidth: 140, height: 44 }}
                                    >
                                        {HOLD_MUSIC_OPTIONS.map(opt => (
                                            <option key={opt.url} value={opt.url}>
                                                {opt.label}
                                            </option>
                                        ))}
                                    </select>
                                    <span className="ctrl-label">En espera</span>
                                </div>

                                <div className="controls-sep" />

                                {/* Grabar */}
                                <div className="ctrl-btn-wrap">
                                    <Tooltip title={isRecording ? "Detener grabación" : "Iniciar grabación"} placement="top">
                                        <div className={`ctrl-icon-box ${isRecording ? "rec-active" : ""}`}>
                                            <IconButton
                                                onClick={handleToggleRecord}
                                                size="small"
                                                className={isRecording ? "icon-rec-active" : "icon-default"}
                                                sx={{ "&:hover": { bgcolor: "transparent" } }}
                                            >
                                                {isRecording
                                                    ? <StopIcon fontSize="small" />
                                                    : <FiberManualRecordIcon fontSize="small" />}
                                            </IconButton>
                                        </div>
                                    </Tooltip>
                                    <span className={`ctrl-label ${isRecording ? "rec-on" : ""}`}>
                                        {isRecording ? "Grabando" : "Grabar"}
                                    </span>
                                </div>

                            </div>
                        )}

                        {/* ── EMISOR: crear enlace ── */}
                        {!isReceiver && (
                            <>
                                {status !== "ended" && (
                                    <Button
                                        variant="contained"
                                        fullWidth
                                        startIcon={
                                            status === "generating"
                                                ? <CircularProgress size={14} color="inherit" />
                                                : <LinkIcon />
                                        }
                                        disabled={BUSY_STATUSES.includes(status)}
                                        onClick={handleCreateCallLink}
                                        className="!rounded-[13px] !normal-case !font-medium !text-sm !text-white"
                                        sx={{
                                            py: 1.1,
                                            background: "linear-gradient(135deg,#2563eb,#1d4ed8)",
                                            boxShadow: "0 4px 20px rgba(37,99,235,.35)",
                                            "&:hover": { background: "linear-gradient(135deg,#2563eb,#1d4ed8)", boxShadow: "0 6px 28px rgba(37,99,235,.5)" },
                                            "&.Mui-disabled": { opacity: 0.4, color: "white" },
                                        }}
                                    >
                                        {status === "generating" ? "Generando enlace..." : "Crear nuevo enlace de llamada"}
                                    </Button>
                                )}

                                {generatedToken && status !== "ended" && (
                                    <div className="flex flex-col gap-3">
                                        <span className="text-[0.72rem] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                                            Compartir Link
                                        </span>
                                        <div className="flex items-center gap-2">
                                            <input
                                                readOnly
                                                value={generatedLink}
                                                title={generatedLink}
                                                className="
                                                    flex-1 rounded-xl px-4 py-2.5
                                                    text-[0.75rem] font-mono outline-none truncate
                                                    bg-slate-100 border border-slate-200 text-slate-700
                                                    dark:bg-slate-800/60 dark:border-slate-700/50 dark:text-slate-300
                                                "
                                            />
                                            <Tooltip title="Copiar link" placement="top">
                                                <IconButton
                                                    onClick={() => copyToClipboard(generatedLink)}
                                                    size="small"
                                                    className={copied === "link" ? "copy-btn-ok" : "copy-btn-default"}
                                                    sx={{ width: 38, height: 38, borderRadius: "10px", border: "1px solid" }}
                                                >
                                                    {copied === "link"
                                                        ? <CheckIcon fontSize="small" />
                                                        : <ContentCopyIcon fontSize="small" />}
                                                </IconButton>
                                            </Tooltip>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}

                        {/* ── RECEPTOR: idle / connecting ── */}
                        {isReceiver && (status === "idle" || status === "connecting") && (
                            <div className="
                                flex flex-col items-center gap-3 text-center p-6 rounded-2xl border
                                bg-emerald-50 border-emerald-200
                                dark:bg-emerald-500/[0.06] dark:border-emerald-500/20
                            ">
                                <PhoneCallbackIcon className="text-emerald-600 dark:text-emerald-400" sx={{ fontSize: 40 }} />
                                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                                    Te invitaron a una llamada
                                </p>
                                <p className="text-[0.78rem] leading-relaxed text-slate-500 dark:text-slate-400">
                                    {status === "connecting"
                                        ? "Conectando al servidor..."
                                        : <>Presiona{" "}<strong className="text-slate-700 dark:text-slate-300">Unirse a la llamada</strong>{" "}para conectarte.</>
                                    }
                                </p>
                            </div>
                        )}

                        {/* ── EMISOR: ended ── */}
                        {!isReceiver && status === "ended" && (
                            <div className="
                                flex flex-col items-center gap-3 text-center p-6 rounded-2xl border
                                bg-slate-100 border-slate-200
                                dark:bg-slate-800/40 dark:border-slate-700/30
                            ">
                                <ReplayIcon className="text-slate-400 dark:text-slate-500" sx={{ fontSize: 40 }} />
                                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                                    Llamada finalizada
                                </p>
                                <p className="text-[0.78rem] text-slate-500 dark:text-slate-400">
                                    Genera un nuevo enlace para continuar.
                                </p>
                                <Button
                                    variant="contained"
                                    startIcon={
                                        isResetting
                                            ? <CircularProgress size={14} color="inherit" />
                                            : <LinkIcon />
                                    }
                                    disabled={isResetting}
                                    onClick={handleReset}
                                    sx={{
                                        borderRadius: "13px",
                                        textTransform: "none",
                                        fontWeight: 500,
                                        fontSize: "0.875rem",
                                        py: 1,
                                        color: "white",
                                        background: "linear-gradient(135deg,#2563eb,#1d4ed8)",
                                        boxShadow: "0 4px 20px rgba(37,99,235,.35)",
                                        "&:hover": { background: "linear-gradient(135deg,#2563eb,#1d4ed8)", boxShadow: "0 6px 28px rgba(37,99,235,.5)" },
                                    }}
                                >
                                    {isResetting ? "Generando enlace..." : "Generar nuevo enlace"}
                                </Button>
                            </div>
                        )}

                        {/* ── RECEPTOR: ended ── */}
                        {isReceiver && status === "ended" && (
                            <div className="
                                flex flex-col items-center gap-3 text-center p-6 rounded-2xl border
                                bg-slate-100 border-slate-200
                                dark:bg-slate-800/40 dark:border-slate-700/30
                            ">
                                <ReplayIcon className="text-slate-400 dark:text-slate-500" sx={{ fontSize: 40 }} />
                                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                                    Llamada finalizada
                                </p>
                                <p className="text-[0.78rem] text-slate-500 dark:text-slate-400">
                                    Para continuar, solicita un nuevo enlace.
                                </p>
                            </div>
                        )}

                        {/* Divisor */}
                        <Divider className="border-slate-200 dark:border-white/[0.06]" />

                        {/* ── Actions row ── */}
                        <div className="flex items-center gap-2.5">

                            {/* Llamar / Unirse */}
                            <Button
                                variant="contained"
                                fullWidth
                                startIcon={<CallIcon />}
                                disabled={BUSY_STATUSES.includes(status)}
                                onClick={handleStartCall}
                                className="!rounded-[13px] !normal-case !font-medium !text-sm !text-white"
                                sx={{
                                    py: 1.1,
                                    background: "linear-gradient(135deg,#059669,#047857)",
                                    boxShadow: "0 4px 20px rgba(5,150,105,.35)",
                                    "&:hover": {
                                        background: "linear-gradient(135deg,#059669,#047857)",
                                        boxShadow: "0 6px 28px rgba(5,150,105,.5)",
                                    },
                                    "&.Mui-disabled": { opacity: 0.4, color: "white" },
                                }}
                            >
                                {isReceiver ? "Unirse a la llamada" : "Llamar"}
                            </Button>

                            {/* Colgar */}
                            <Tooltip title="Colgar" placement="top">
                                <span>
                                    <IconButton
                                        onClick={handleHangUp}
                                        disabled={!BUSY_HANG.includes(status)}
                                        className="!text-white !rounded-full !flex-shrink-0 !w-[46px] !h-[46px]"
                                        sx={{
                                            background: "linear-gradient(135deg,#dc2626,#b91c1c)",
                                            boxShadow: "0 4px 20px rgba(220,38,38,.35)",
                                            "&:hover": {
                                                background: "linear-gradient(135deg,#dc2626,#b91c1c)",
                                                boxShadow: "0 6px 28px rgba(220,38,38,.5)",
                                            },
                                            "&.Mui-disabled": {
                                                opacity: 0.4,
                                                background: "linear-gradient(135deg,#dc2626,#b91c1c)",
                                                color: "white"
                                            },
                                        }}
                                    >
                                        <CallEndIcon fontSize="small" />
                                    </IconButton>
                                </span>
                            </Tooltip>

                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}
