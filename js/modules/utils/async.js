/** Cancel a wait without losing ownership of a resource that arrives afterwards. */
export function abortable(promise, signal, disposeLate = () => {}) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return disposeLate(value);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    }).catch(reject);
    if (signal.aborted) onAbort();
  });
}
