// Voice input through the browser's Web Speech API: free, nothing of ours is involved, and the
// button is simply absent where the browser doesn't have it. The browser decides where the audio
// is processed (Chrome sends it to its vendor's service), so it only starts when the subscriber
// presses the button, one phrase at a time, and never records on its own.

export interface SpeechResultEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }> & { readonly isFinal: boolean }>;
}

export interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

export type RecognitionCtor = new () => Recognition;

export function speechSupport(scope: object = globalThis): RecognitionCtor | null {
  const found = scope as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return found.SpeechRecognition ?? found.webkitSpeechRecognition ?? null;
}

/** The text of the phrases that are final in this event, or "" if there are none yet. */
export function finalTranscript(event: SpeechResultEvent): string {
  let text = "";
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i];
    if (result?.isFinal) text += result[0]?.transcript ?? "";
  }
  return text.trim();
}
