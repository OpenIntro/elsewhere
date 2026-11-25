/** Tiny typed event bus for server→client messages (fan-out to any subsystem). */
import type { S2CPayloads, S2CType } from '@elsewhere/shared';

type Handler<T extends S2CType> = (payload: S2CPayloads[T]) => void;

export class ServerEvents {
  private handlers = new Map<S2CType, Set<Handler<S2CType>>>();

  on<T extends S2CType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as Handler<S2CType>);
    return () => set.delete(handler as Handler<S2CType>);
  }

  emit<T extends S2CType>(type: T, payload: S2CPayloads[T]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of set) {
      try {
        (h as Handler<T>)(payload);
      } catch (err) {
        console.error(`[net] handler for ${type} failed`, err);
      }
    }
  }
}
