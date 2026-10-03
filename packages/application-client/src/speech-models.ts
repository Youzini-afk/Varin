/** Shared client defaults and the Host's downloadable speech-model metadata. */
export const DEFAULT_LOCAL_STT_MODEL = 'whisper-turbo-int8';

export interface LocalSttModelInfo {
  id: string;
  name: string;
  languages: readonly string[];
  supportsLanguageSelection: boolean;
  downloadBytes: number;
  sourceUrl: string;
}

export interface LocalSttModelStatus extends LocalSttModelInfo {
  installed: boolean;
  downloading: boolean;
  downloadProgress: number | null;
  downloadError: string | null;
}
