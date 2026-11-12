import { ClassicBackend } from './classic.js';
import { NativeBackend } from './native.js';

export const BACKENDS = ['classic', 'native'];

/** The voice engine chosen with VOICE_BACKEND. */
export function createBackend(config, log) {
  return config.voice.backend === 'native'
    ? new NativeBackend(config, log.child('native'))
    : new ClassicBackend(config, log); // keeps the log scopes Classic always had
}
