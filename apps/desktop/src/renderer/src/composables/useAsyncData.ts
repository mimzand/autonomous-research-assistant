import {
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  shallowRef,
  type Ref,
  type ShallowRef,
} from 'vue';

export interface AsyncDataOptions {
  /** Re-load every N ms while the page is visible (null = no polling). */
  readonly pollMs?: () => number | null;
}

export interface AsyncData<T> {
  readonly data: ShallowRef<T | null>;
  readonly loading: Ref<boolean>;
  readonly error: Ref<string | null>;
  readonly loaded: Ref<boolean>;
  refresh(options?: { silent?: boolean }): Promise<void>;
  /** Re-evaluates the poll interval (e.g. after starting a task). */
  reschedule(): void;
}

/**
 * Loads data through the preload bridge with loading/error state.
 * Only the newest request may update the state, so a slow, stale
 * response never overwrites a newer one (e.g. while typing a search).
 */
export function useAsyncData<T>(
  loader: () => Promise<T>,
  options: AsyncDataOptions = {},
): AsyncData<T> {
  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** True once the first request has finished (success or error). */
  const loaded = ref(false);
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;

  async function refresh(opts: { silent?: boolean } = {}): Promise<void> {
    const id = ++sequence;
    if (!opts.silent) loading.value = true;
    try {
      const result = await loader();
      if (id === sequence) {
        data.value = result;
        error.value = null;
      }
    } catch (cause) {
      if (id === sequence) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (id === sequence) {
        loading.value = false;
        loaded.value = true;
      }
    }
  }

  function schedule(): void {
    clearTimeout(timer);
    const ms = options.pollMs?.();
    if (!active || !ms) return;
    timer = setTimeout(() => {
      void refresh({ silent: true }).finally(schedule);
    }, ms);
  }

  function start(): void {
    active = true;
    void refresh({ silent: data.value !== null }).finally(schedule);
  }

  function stop(): void {
    active = false;
    clearTimeout(timer);
  }

  onMounted(start);
  onActivated(() => {
    if (!active) start();
  });
  onDeactivated(stop);
  onBeforeUnmount(stop);

  return { data, loading, error, loaded, refresh, reschedule: schedule };
}
