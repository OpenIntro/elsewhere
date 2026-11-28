export { net, NetClient, type ConnectOptions, type NetLifecycleEvent } from './connection.js';
export { actions } from './actions.js';
export { rest, RestError, setAuthToken } from './rest.js';
export { sampleRemote, sampleBuffer, pushSnapshot, removeRemote, EXTRAPOLATE_MS, TELEPORT_DISTANCE } from './interpolation.js';
export { installDebugHook, registerDebugSection, registerDebugQuery, type DebugSnapshot } from './debug.js';
export { ClientRateLimiter } from './rateLimit.js';
