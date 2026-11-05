import { type JsonValue, type SourceRecord, type Storage } from '@rka/storage';
import { type SourceStore, type StoredSourceRef } from '@rka/tools';

const ref = (source: SourceRecord): StoredSourceRef => ({
  id: source.id,
  url: source.url,
  title: source.title,
});

/**
 * Keeps sources collected by the web tools in SQLite. A source and its text
 * are written in one transaction, so a crash never leaves a source without
 * its content.
 */
export function createSourceStore(storage: Storage): SourceStore {
  return {
    findByUrl(taskId, canonicalUrl) {
      const source = storage.sources.findByUrl(taskId, canonicalUrl);
      return source && ref(source);
    },
    findByContentHash(taskId, textSha256) {
      const source = storage.sources.findByContentHash(taskId, textSha256);
      return source && ref(source);
    },
    save(taskId, source) {
      return storage.transaction((repos) => {
        const saved = repos.sources.add(taskId, {
          url: source.url,
          ...(source.title !== null && { title: source.title }),
          retrievedAt: source.retrievedAt,
          // Plain JSON by construction (strings, numbers, booleans, arrays); validated by storage.
          metadata: source.metadata as unknown as JsonValue,
        });
        repos.sources.setContent(saved.id, { contentType: source.contentType, text: source.text });
        return ref(saved);
      });
    },
  };
}
