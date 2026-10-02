import type { Object3D } from 'three';
import type { InteractionPrompt } from '../interaction.js';
import { pixelToGround } from './coords.js';
import { INTERACTION_PROMPT_STYLE } from './palette.js';
import type { LabelFactory, TextLabel } from './types.js';

/**
 * D-117: the shared "E · …" prompt, drawn for whichever station the
 * session's interaction system focuses: a plaza station, a room counter, a
 * Studio figure, the bunker's lift. One floating label in the plaza's prompt
 * style (D-076), moved to the focused station and bobbing gently there, so
 * every station's prompt looks and behaves the same.
 */

/** How far above the floor the prompt floats when the station names no height, world units. */
export const DEFAULT_PROMPT_HEIGHT = 2.6;
/** The bob's amplitude, world units, and its rate, radians per second (the plaza's). */
const BOB_AMPLITUDE = 0.05;
const BOB_RATE = 3;

export interface InteractionPromptView {
  readonly object: Object3D;
  /** The prompt showing now, or none. */
  readonly shown: InteractionPrompt | null;
  /** Float the prompt over this station, `height` above `floor`; or hide it. */
  show(prompt: InteractionPrompt | null, height?: number, floor?: number): void;
  update(deltaMs: number): void;
  dispose(): void;
}

export function promptText(label: string): string {
  return `E · ${label}`;
}

export function createInteractionPromptView(labels: LabelFactory): InteractionPromptView {
  const label: TextLabel = labels.floating(promptText(''), INTERACTION_PROMPT_STYLE);
  label.object.name = 'interaction-prompt';
  label.object.userData['interaction'] = 'prompt';
  label.object.visible = false;
  let shown: InteractionPrompt | null = null;
  let text = '';
  let baseY = 0;
  let elapsed = 0;
  return {
    object: label.object,
    get shown() {
      return shown;
    },
    show(prompt, height = DEFAULT_PROMPT_HEIGHT, floor = 0) {
      shown = prompt;
      if (!prompt) {
        label.object.visible = false;
        return;
      }
      const next = promptText(prompt.label);
      if (next !== text) {
        text = next;
        label.setText(next);
      }
      const ground = pixelToGround(prompt.x, prompt.y);
      baseY = (Number.isFinite(floor) ? floor : 0) + (Number.isFinite(height) ? height : DEFAULT_PROMPT_HEIGHT);
      label.object.position.set(ground.x, baseY, ground.z);
      label.object.userData['station'] = prompt.id;
      label.object.visible = true;
    },
    update(deltaMs) {
      if (!label.object.visible) return;
      elapsed += Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
      label.object.position.y = baseY + BOB_AMPLITUDE * Math.sin((elapsed / 1000) * BOB_RATE);
    },
    dispose() {
      label.object.parent?.remove(label.object);
      label.dispose();
    },
  };
}
