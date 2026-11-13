// Adapted from the 21st.dev "ai-chat-input" component. Kept: the expanding
// card, send button and real voice dictation. Removed: model picker, effort
// level, image attachments and the simulated voice fallback.
import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const SPRING = "cubic-bezier(0.175, 0.885, 0.32, 1.275)";
const SPRING_TRANSITION = `max-width 0.4s ${SPRING}, height 0.4s ${SPRING}`;
const SMOOTH_HEIGHT_TRANSITION = `max-width 0.4s ${SPRING}, height 0.15s ease-out`;
const BANDS = 5;
/** How much the level bars amplify the voice. */
const LEVEL_GAIN = 3;

// Web Speech API: not in TypeScript's DOM lib, and Chromium ships it prefixed.
type SpeechAlternative = { transcript: string };
type SpeechResult = { isFinal: boolean; 0: SpeechAlternative };
type SpeechEvent = { resultIndex: number; results: ArrayLike<SpeechResult> };
type SpeechRecognizer = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognizerCtor = new () => SpeechRecognizer;

function speechRecognizer(): SpeechRecognizerCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognizerCtor; webkitSpeechRecognition?: SpeechRecognizerCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function ArrowUpIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 12V2M7 2L2.5 6.5M7 2L11.5 6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="5" y="1" width="4" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.75 6.5V7a4.25 4.25 0 0 0 8.5 0v-.5M7 11.25V13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  );
}

export interface PromptInputProps {
  onSubmit?: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function PromptInput({ onSubmit, placeholder = "Tell Inti what you want to do", className, disabled = false }: PromptInputProps) {
  const [expanded, setExpanded] = useState(false);
  const [isSmoothResize, setIsSmoothResize] = useState(false);
  const [value, setValue] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [audioData, setAudioData] = useState<number[]>(() => new Array<number>(BANDS).fill(0));
  const [containerHeight, setContainerHeight] = useState(116);
  const [textareaHeight, setTextareaHeight] = useState(68);
  const [isScrolling, setIsScrolling] = useState(false);
  const [canDictate] = useState(() => speechRecognizer() !== null && Boolean(navigator.mediaDevices?.getUserMedia));

  const valueRef = useRef(value);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognizer | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const topFadeRef = useRef<HTMLDivElement>(null);
  const bottomFadeRef = useRef<HTMLDivElement>(null);

  const hasValue = value.trim() !== "";

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const updateFades = () => {
    const el = textareaRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (topFadeRef.current) topFadeRef.current.style.opacity = Math.min(scrollTop / 20, 1).toString();
    if (bottomFadeRef.current) {
      const bottomScroll = scrollHeight - clientHeight - scrollTop;
      bottomFadeRef.current.style.opacity = Math.min(Math.max(bottomScroll - 16, 0) / 10, 1).toString();
    }
  };

  const handleValueChange = useCallback((val: string) => {
    setIsSmoothResize(true);
    setValue(val);
  }, []);

  const stopRecording = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setIsRecording(false);
    setAudioData(new Array<number>(BANDS).fill(0));
  }, []);

  const startRecording = useCallback(async () => {
    const Recognizer = speechRecognizer();
    if (!Recognizer) return;
    setMicError(null);
    setIsSmoothResize(false);
    setExpanded(true);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicError("Could not use the microphone. Check the browser permission.");
      return;
    }
    streamRef.current = stream;
    setIsRecording(true);

    // Level meter for the bars next to the stop button.
    const audioCtx = new AudioContext();
    audioContextRef.current = audioCtx;
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const step = Math.floor(data.length / BANDS);
    const meter = () => {
      analyser.getByteFrequencyData(data);
      const bands = Array.from({ length: BANDS }, (_, i) => {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += data[i * step + j] ?? 0;
        // A normal speaking voice fills only a small part of the range: amplified so the bars move with it.
        return Math.min(1, (sum / step / 255) * LEVEL_GAIN);
      });
      setAudioData(bands);
      rafRef.current = requestAnimationFrame(meter);
    };
    meter();

    const recognition = new Recognizer();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language;
    let baseline = valueRef.current;
    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (final) baseline += (baseline ? " " : "") + final.trim();
      handleValueChange((baseline + (interim ? " " + interim : "")).trim());
    };
    recognition.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") setMicError("Dictation stopped because of a browser error.");
      stopRecording();
    };
    recognition.onend = () => stopRecording();
    recognitionRef.current = recognition;
    recognition.start();
  }, [handleValueChange, stopRecording]);

  // Keep the textarea scrolled to the end while dictating.
  useEffect(() => {
    if (isRecording && textareaRef.current) textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
  }, [value, isRecording]);

  // Release the microphone on unmount.
  useEffect(() => stopRecording, [stopRecording]);

  useEffect(() => {
    if (hasValue && !expanded) {
      setIsSmoothResize(false);
      setExpanded(true);
    }
  }, [hasValue, expanded]);

  useEffect(() => {
    if (!expanded || isRecording) return;
    const timer = setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 50);
    return () => clearTimeout(timer);
  }, [expanded, isRecording]);

  // Grow the textarea with its content, up to 160px.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const currentHeight = el.style.height;
    el.style.transition = "none";
    el.style.height = "0px";
    const scrollHeight = el.scrollHeight;
    el.style.height = currentHeight;
    void el.offsetHeight;
    el.style.transition = "";
    const newHeight = Math.max(68, Math.min(scrollHeight, 160));
    el.style.height = `${newHeight}px`;
    setTextareaHeight(newHeight);
    setIsScrolling(scrollHeight > 160);
    setTimeout(updateFades, 0);
  }, [value, expanded]);

  useEffect(() => {
    setContainerHeight(Math.max(116, textareaHeight + 48));
    setTimeout(updateFades, 0);
  }, [textareaHeight]);

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (containerRef.current?.contains(e.relatedTarget as Node)) return;
    if (!hasValue && !isRecording) {
      setIsSmoothResize(false);
      setExpanded(false);
    }
  };

  const handleSubmit = () => {
    if (!hasValue || disabled) return;
    if (isRecording) stopRecording();
    setIsSmoothResize(false);
    onSubmit?.(value.trim());
    handleValueChange("");
    setExpanded(false);
  };

  // While dictating, the main button sends (and stops dictation) in one tap; a stop button sits to its left.
  const showMic = !hasValue && !isRecording && canDictate;
  const showArrow = !showMic;

  const onActionButtonClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (hasValue) handleSubmit();
    else if (!isRecording && canDictate) void startRecording();
  };

  return (
    <div
      ref={containerRef}
      onBlur={handleBlur}
      className={cn("relative flex w-full flex-col", className)}
      style={{
        maxWidth: expanded ? 560 : 400,
        transition: isSmoothResize ? "max-width 0.15s ease-out" : `max-width 0.4s ${SPRING}`,
      }}
    >
      <div
        onMouseDown={(e) => {
          if (expanded && e.target !== textareaRef.current && !isRecording) {
            e.preventDefault();
            textareaRef.current?.focus();
          }
        }}
        style={{
          borderRadius: 24,
          height: expanded ? containerHeight : 52,
          transition: isSmoothResize ? SMOOTH_HEIGHT_TRANSITION : SPRING_TRANSITION,
          overflow: expanded ? "visible" : "hidden",
        }}
        className={cn(
          "relative z-10 w-full border border-border bg-card shadow-sm hover:border-primary/30 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15",
          expanded ? "cursor-text" : "cursor-default",
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => handleValueChange(e.target.value)}
          onScroll={updateFades}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
            if (e.key === "Escape" && !hasValue) {
              setIsSmoothResize(false);
              setExpanded(false);
            }
          }}
          placeholder={placeholder}
          aria-label="Message for Inti"
          disabled={isRecording}
          style={{
            transition: isSmoothResize
              ? "height 0.15s ease-out"
              : `opacity 0.3s ease-out, transform 0.3s ease-out, height 0.4s ${SPRING}`,
          }}
          className={cn(
            "prompt-scrollbar absolute inset-x-0 top-0 z-[1] w-full cursor-text resize-none bg-transparent py-3.5 pr-12 pl-4 text-[15px] leading-[22px] text-foreground outline-none placeholder:font-medium placeholder:text-muted-foreground/80",
            expanded ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none -translate-y-1 scale-95 opacity-0",
            isScrolling ? "overflow-y-auto" : "overflow-y-hidden",
            isRecording && "pointer-events-none",
          )}
        />

        <div
          ref={topFadeRef}
          className="pointer-events-none absolute top-0 right-12 left-4 z-[2] h-8 bg-gradient-to-b from-card via-card/90 to-transparent"
        />
        <div
          ref={bottomFadeRef}
          className="pointer-events-none absolute right-12 left-4 z-[2] h-8 bg-gradient-to-t from-card via-card/90 to-transparent"
          style={{
            opacity: 0,
            top: `${textareaHeight - 32}px`,
            transition: isSmoothResize ? "top 0.15s ease-out" : `top 0.4s ${SPRING}`,
          }}
        />

        <button
          type="button"
          onClick={() => {
            setIsSmoothResize(false);
            setExpanded(true);
          }}
          style={{ transition: isSmoothResize ? "none" : `all 0.4s ${SPRING}` }}
          className={cn(
            "absolute inset-x-0 top-0 z-[1] cursor-text py-[17px] pr-12 pl-4 text-left text-[15px] leading-[17px] font-medium text-muted-foreground/80 outline-none",
            !expanded ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-1 scale-105 opacity-0",
          )}
          aria-label="Open the message box"
        >
          {placeholder}
        </button>

        {micError && expanded && <p className="absolute bottom-3 left-4 z-[10] text-xs text-destructive">{micError}</p>}

        {/* Level bars, left of the stop and send buttons while dictating. */}
        <div
          className={cn(
            "absolute right-[5.25rem] bottom-2.5 z-[10] flex h-8 items-center justify-end gap-[3px] transition-all duration-400",
            isRecording ? "w-16 translate-x-0 opacity-100" : "pointer-events-none w-0 translate-x-4 opacity-0",
          )}
        >
          {audioData.map((val, i) => (
            <div
              key={i}
              className="w-1 rounded-full bg-primary transition-[height] duration-75 ease-out"
              style={{ height: `${Math.max(4, val * 24)}px` }}
            />
          ))}
        </div>

        {/* Stops dictating and keeps the text, to read or edit it before sending. */}
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={stopRecording}
          aria-label="Stop dictation"
          title="Stop dictation"
          tabIndex={isRecording ? 0 : -1}
          style={{ borderRadius: 9999 }}
          className={cn(
            "absolute right-12 bottom-2.5 z-[10] flex h-8 w-8 items-center justify-center border border-border bg-card text-foreground transition-all duration-300 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
            isRecording ? "scale-100 opacity-100" : "pointer-events-none scale-50 opacity-0",
          )}
        >
          <StopIcon />
        </button>

        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={onActionButtonClick}
          disabled={showArrow && (!hasValue || disabled)}
          aria-label={showMic ? "Dictate with the microphone" : "Send"}
          style={{ borderRadius: 9999 }}
          className="absolute right-2.5 bottom-2.5 z-[10] flex h-8 w-8 items-center justify-center bg-primary text-primary-foreground transition-all duration-300 outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <span className="relative flex h-full w-full items-center justify-center">
            <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300", showArrow ? "scale-100 rotate-0 opacity-100" : "pointer-events-none scale-50 rotate-45 opacity-0")}>
              <ArrowUpIcon />
            </span>
            <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300", showMic ? "scale-100 rotate-0 opacity-100" : "pointer-events-none scale-50 -rotate-45 opacity-0")}>
              <MicIcon />
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}
