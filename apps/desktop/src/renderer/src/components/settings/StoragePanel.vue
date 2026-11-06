<script setup lang="ts">
import { computed } from 'vue';
import { useAsyncData } from '../../composables/useAsyncData';
import { handleResult, useSettings } from '../../composables/useSettings';
import { formatDateTime } from '../../lib/format';
import { formatBytes } from '../../lib/settings';

/** Database information (read-only) and the backup folder. */
const status = useAsyncData(() => window.api.storage.status());
const { view, reset } = useSettings();

const totalRecords = computed(
  () => status.data.value?.tables.reduce((sum, t) => sum + t.rows, 0) ?? 0,
);
const size = computed(() => {
  const f = status.data.value?.files;
  return f ? f.databaseBytes + f.walBytes + f.shmBytes : null;
});
const folder = computed(() => view.value?.values['backup.defaultDirectory'] ?? null);

async function chooseFolder(): Promise<void> {
  const result = await window.api.settings.chooseBackupFolder();
  if (result.status !== 'cancelled') handleResult(result, 'Backup folder saved.');
}
</script>

<template>
  <div class="panel" data-testid="storage-panel">
    <section class="card info">
      <h3>Database</h3>
      <div v-if="status.error.value" class="error" role="alert">{{ status.error.value }}</div>
      <div v-else-if="!status.data.value" class="muted">Loading…</div>
      <dl v-else data-testid="storage-info">
        <dt>Location</dt>
        <dd>
          <code data-testid="db-path">{{ status.data.value.path }}</code>
        </dd>
        <dt>Connection</dt>
        <dd :data-tone="status.data.value.connected ? 'ok' : 'error'" class="tone">
          {{ status.data.value.connected ? 'Connected' : 'Not connected' }}
        </dd>
        <dt>Size</dt>
        <dd>{{ formatBytes(size) }}</dd>
        <dt>Journal mode</dt>
        <dd>{{ status.data.value.journalMode.toUpperCase() }}</dd>
        <dt>Last integrity check</dt>
        <dd>
          <template v-if="status.data.value.lastIntegrityCheck">
            {{ status.data.value.lastIntegrityCheck.ok ? 'OK' : 'Problems found' }} ·
            {{ formatDateTime(status.data.value.lastIntegrityCheck.checkedAt) }}
          </template>
          <template v-else>Never (run it on the Storage page)</template>
        </dd>
        <dt>Total records</dt>
        <dd data-testid="total-records">{{ totalRecords.toLocaleString('en-US') }}</dd>
      </dl>
      <p class="muted small">
        The database lives in the app data folder and cannot be moved from here: moving an open
        database safely needs a migration step this version does not have. To move your data, export
        a backup on the Storage page.
      </p>
      <button type="button" @click="status.refresh()">Refresh</button>
    </section>

    <section class="card info" data-testid="backup-settings">
      <h3>Backups</h3>
      <p>
        Backup folder:
        <strong data-testid="backup-folder">{{ folder ?? 'Documents (default)' }}</strong>
      </p>
      <p class="muted small">
        The "Export backup…" Save dialog opens in this folder. You still choose the file name and
        confirm every backup; existing files are never overwritten without asking.
      </p>
      <div class="actions">
        <button
          type="button"
          class="primary"
          data-testid="choose-backup-folder"
          @click="chooseFolder"
        >
          Choose folder…
        </button>
        <button
          type="button"
          :disabled="!folder"
          @click="reset(['backup.defaultDirectory'], 'Backup folder reset to Documents.')"
        >
          Use Documents
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.panel {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.panel > * {
  min-width: 0;
}
.info {
  padding: 14px 16px;
}
h3 {
  margin: 0 0 8px;
  font-size: 1rem;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 0 0 10px;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.tone {
  color: var(--tone-fg);
}
.actions {
  display: flex;
  gap: 8px;
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 0.85rem;
}
.error {
  color: var(--error);
}
</style>
