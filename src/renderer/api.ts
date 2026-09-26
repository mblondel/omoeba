import type { OmoebaAPI, OmoebaEvent } from '../shared/types';

export interface RendererAPI extends OmoebaAPI {
  onEvent(cb: (e: OmoebaEvent) => void): () => void;
  onMenu(cb: (action: string) => void): () => void;
  platform: string;
}

export const api = (window as unknown as { omoeba: RendererAPI }).omoeba;

let jobCounter = 0;
export const newJobId = () => `job-${Date.now()}-${++jobCounter}`;
