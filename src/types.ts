/** Script généré par le LLM. */
export interface VideoScript {
  title: string;
  hook: string;
  scenes: { text: string; visual_prompt: string }[];
  call_to_action: string;
  hashtags: string[];
}

/** Mot aligné sur la piste audio (secondes). */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface Narration {
  audioPath: string;
  duration: number;
  words: WordTiming[];
}

/** Un segment narratif (hook, scène, CTA) avec son intervalle dans l'audio. */
export interface TimedSegment {
  text: string;
  visualPrompt: string;
  start: number;
  end: number;
}

export interface VisualAsset {
  path: string;
  kind: "video" | "image";
  source: string;
}

/** Entrée du moteur vidéo : un plan = un visuel affiché pendant `duration` secondes. */
export interface Shot {
  asset: VisualAsset;
  duration: number;
}
