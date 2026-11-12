import { AsyncLocalStorage } from 'node:async_hooks';

type AcquireWriter = () => Promise<() => void>;
const writerContext = new AsyncLocalStorage<AcquireWriter>();

/** 服务内只排队获取写会话，业务操作之间仍可释放写锁。 */
export class WriterQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(action: () => Promise<T>): Promise<T> {
    return writerContext.run(async () => {
      const before = this.tail;
      let release!: () => void;
      this.tail = new Promise<void>(resolve => { release = resolve; });
      await before;
      return release;
    }, action);
  }
}

export function acquireQueuedWriter(): Promise<() => void> | undefined {
  return writerContext.getStore()?.();
}
