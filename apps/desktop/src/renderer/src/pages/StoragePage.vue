<script setup lang="ts">
import { type BackupResult, type IntegrityCheckResult } from '@rka/shared';
import { computed, ref } from 'vue';
import ErrorBanner from '../components/ui/ErrorBanner.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import { useAsyncData } from '../composables/useAsyncData';
import { formatBytes, formatDateTime, formatNumber, formatRelative } from '../lib/format';

const status = useAsyncData(() => window.api.storage.status());

const checking = ref(false);
const checkResult = ref<IntegrityCheckResult | null>(null);
const checkError = ref<string | null>(null);
const backingUp = ref(false);
const backupResult = ref<BackupResult | null>(null);

const data = computed(() => status.data.value);
const totalBytes = computed(() =>
  data.value
    ? data.value.files.databaseBytes + data.value.files.walBytes + data.value.files.shmBytes
    : 0,
);
const totalRows = computed(() => data.value?.tables.reduce((sum, t) => sum + t.rows, 0) ?? 0);
const lastCheck = computed(() => checkResult.value ?? data.value?.lastIntegrityCheck ?? null);

const TABLE_LABELS: Record<string, string> = {
  tasks: 'Research tasks',
  task_steps: 'Execution steps',
  sources: 'Sources',
  source_contents: 'Extracted contents',
  reports: 'Report versions',
  model_usage: 'Model calls',
  settings: 'Settings (values not shown)',
  approvals: 'Approvals',
};

async function runIntegrityCheck(): Promise<void> {
  checking.value = true;
  checkError.value = null;
  try {
    checkResult.value = await window.api.storage.integrityCheck();
    await status.refresh({ silent: true });
  } catch (error) {
    checkError.value = error instanceof Error ? error.message : String(error);
  } finally {
    checking.value = false;
  }
}

async function backup(): Promise<void> {
  backingUp.value = true;
  backupResult.value = null;
  try {
    backupResult.value = await window.api.storage.backup();
  } catch (error) {
    backupResult.value = {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    backingUp.value = false;
  }
}
</script>

<template>
  <section class="page" data-testid="storage-page">
    <PageHeader
      title="Storage"
      subtitle="The local SQLite database that keeps every task, step, source and report."
    >
      <template #actions>
        <button type="button" class="secondary" @click="status.refresh()">Refresh</button>
      </template>
    </PageHeader>

    <ErrorBanner
      v-if="status.error.value"
      :message="status.error.value"
      @retry="status.refresh()"
    />
    <div v-else-if="!status.loaded.value" class="loading" role="status">
      Reading database status…
    </div>

    <template v-else-if="data">
      <div class="stats">
        <div class="stat card" :data-tone="data.connected ? 'ok' : 'error'">
          <span>Connection</span>
          <b data-testid="storage-connection">{{
            data.connected ? 'Connected' : 'Disconnected'
          }}</b>
        </div>
        <div class="stat card" data-tone="neutral">
          <span>Database size</span>
          <b data-testid="storage-size">{{ formatBytes(totalBytes) }}</b>
        </div>
        <div class="stat card" data-tone="neutral">
          <span>Records</span>
          <b>{{ formatNumber(totalRows) }}</b>
        </div>
        <div class="stat card" :data-tone="lastCheck ? (lastCheck.ok ? 'ok' : 'error') : 'neutral'">
          <span>Last integrity check</span>
          <b>{{ lastCheck ? (lastCheck.ok ? 'Passed' : 'Problems found') : 'Never run' }}</b>
        </div>
      </div>

      <div class="grid">
        <section class="card panel">
          <h3>Database</h3>
          <dl>
            <dt>File</dt>
            <dd class="mono" data-testid="storage-path">{{ data.path }}</dd>
            <dt>Main file</dt>
            <dd>{{ formatBytes(data.files.databaseBytes) }}</dd>
            <dt>Write-ahead log</dt>
            <dd>{{ formatBytes(data.files.walBytes) }}</dd>
            <dt>SQLite version</dt>
            <dd data-testid="storage-sqlite-version">{{ data.sqliteVersion }}</dd>
            <dt>Journal mode</dt>
            <dd data-testid="storage-journal">{{ data.journalMode.toUpperCase() }}</dd>
            <dt>Foreign keys</dt>
            <dd>{{ data.foreignKeys ? 'Enforced' : 'Off' }}</dd>
            <dt>Pages</dt>
            <dd>
              {{ formatNumber(data.pageCount) }} × {{ formatBytes(data.pageSize) }}
              <span class="muted">({{ formatNumber(data.freePages) }} free)</span>
            </dd>
            <dt>Migrations</dt>
            <dd>
              <span
                v-for="m in data.migrations"
                :key="m.tag"
                class="mono"
                :title="`Applied ${formatDateTime(m.appliedAt)}`"
              >
                {{ m.tag }}
              </span>
            </dd>
          </dl>
        </section>

        <section class="card panel">
          <h3>Records per table</h3>
          <table data-testid="storage-tables">
            <tbody>
              <tr v-for="table in data.tables" :key="table.name">
                <th scope="row">
                  <span class="mono">{{ table.name }}</span>
                  <span class="muted label">{{ TABLE_LABELS[table.name] }}</span>
                </th>
                <td class="num">{{ formatNumber(table.rows) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="card panel" data-testid="integrity-panel">
          <h3>Integrity check</h3>
          <p class="muted">
            Runs SQLite's <span class="mono">PRAGMA integrity_check</span>, which reads every page
            and index.
          </p>
          <p>
            Last successful check:
            <b>{{
              data.lastSuccessfulIntegrityCheckAt
                ? formatDateTime(data.lastSuccessfulIntegrityCheckAt)
                : 'never'
            }}</b>
            <span v-if="data.lastSuccessfulIntegrityCheckAt" class="muted">
              ({{ formatRelative(data.lastSuccessfulIntegrityCheckAt) }})
            </span>
          </p>
          <div>
            <button
              type="button"
              class="primary"
              data-testid="run-integrity-check"
              :disabled="checking"
              @click="runIntegrityCheck"
            >
              {{ checking ? 'Checking…' : 'Run integrity check' }}
            </button>
          </div>
          <p v-if="checkError" class="result" data-tone="error" role="alert">{{ checkError }}</p>
          <div
            v-else-if="lastCheck"
            class="result"
            :data-tone="lastCheck.ok ? 'ok' : 'error'"
            role="status"
            data-testid="integrity-result"
          >
            <strong>{{ lastCheck.ok ? 'Database is healthy' : 'SQLite reported problems' }}</strong>
            <span class="muted">
              Checked {{ formatDateTime(lastCheck.checkedAt) }} · took {{ lastCheck.durationMs }} ms
            </span>
            <ul v-if="!lastCheck.ok">
              <li v-for="(message, i) in lastCheck.messages" :key="i" class="mono">
                {{ message }}
              </li>
            </ul>
          </div>
        </section>

        <section class="card panel">
          <h3>Backup</h3>
          <p class="muted">
            Saves a consistent copy of the database to a location you choose, then verifies it.
            Existing files are only replaced after you confirm in the save dialog.
          </p>
          <div>
            <button
              type="button"
              class="secondary"
              data-testid="export-backup"
              :disabled="backingUp"
              @click="backup"
            >
              {{ backingUp ? 'Saving backup…' : 'Export backup…' }}
            </button>
          </div>
          <div
            v-if="backupResult"
            class="result"
            :data-tone="
              backupResult.status === 'saved'
                ? 'ok'
                : backupResult.status === 'failed'
                  ? 'error'
                  : 'neutral'
            "
            role="status"
            data-testid="backup-result"
          >
            <template v-if="backupResult.status === 'saved'">
              <strong>Backup saved{{ backupResult.verified ? ' and verified' : '' }}</strong>
              <span class="mono path">{{ backupResult.path }}</span>
              <span class="muted">{{ formatBytes(backupResult.bytes) }}</span>
            </template>
            <template v-else-if="backupResult.status === 'failed'">
              <strong>Backup failed</strong>
              <span>{{ backupResult.message }}</span>
            </template>
            <span v-else>Backup cancelled. Nothing was written.</span>
          </div>
        </section>
      </div>
      <p class="privacy muted">
        This page shows counts and file information only. Setting values and encrypted secrets are
        never displayed.
      </p>
    </template>
  </section>
</template>

<style scoped>
.page {
  display: grid;
  gap: 16px;
  align-content: start;
}
.loading {
  padding: 48px;
  text-align: center;
  color: var(--muted);
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.stat {
  display: grid;
  padding: 12px 14px;
  border-left: 3px solid var(--tone-fg);
}
.stat span {
  color: var(--muted);
  font-size: 0.85rem;
}
.stat b {
  font-size: 1.3rem;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.panel {
  padding: 16px;
  display: grid;
  gap: 10px;
  align-content: start;
  min-width: 0;
}
h3 {
  margin: 0;
  font-size: 1rem;
}
p {
  margin: 0;
}
dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 14px;
  margin: 0;
  font-size: 0.9rem;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
th {
  text-align: left;
  font-weight: 500;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.label {
  margin-left: 8px;
  font-size: 0.82rem;
}
td {
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.result {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--tone-bg);
}
.result strong {
  color: var(--tone-fg);
}
.result ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.path {
  overflow-wrap: anywhere;
}
.privacy {
  margin: 0;
  font-size: 0.82rem;
}
@media (max-width: 1100px) {
  .grid,
  .stats {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
