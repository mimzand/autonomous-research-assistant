import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { SNAPSHOT_CHUNK_BYTES } from '@rka/agent-protocol';
import { ExtractedSourceViewSchema, MAX_UPLOAD_BYTES } from '@rka/shared';
import { z } from 'zod';
import { type AgentLink } from '../agent-link.js';
import { ApiError, ErrorBodySchema } from '../errors.js';
import { COMMON_ERRORS, route, type ApiRoute } from '../route.js';

/*
 * Phase 3: what the desktop app does with native dialogs, done over HTTP. The file
 * to extract is uploaded (instead of shell.chooseFile), and the backup is a download
 * (instead of a save dialog). Neither touches the API's disk or the database: the
 * agent extracts from the bytes and serves the backup from an in-memory snapshot.
 */

const EXTRACT_TIMEOUT_MS = 5 * 60_000;

export function fileRoutes(agent: AgentLink): ApiRoute[] {
  return [
    route({
      method: 'post',
      path: '/research-tools/extract',
      tag: 'Research tools',
      summary: 'Extract the text of an uploaded PDF or DOCX file',
      description:
        `multipart/form-data with one \`file\` field, at most ${MAX_UPLOAD_BYTES} bytes (and ` +
        "the agent's Maximum fetched content size). The type comes from the name and must match " +
        'the content. Nothing is saved.',
      bodyType: 'multipart',
      body: z.object({
        file: z.instanceof(File, { message: 'expected a file' }).describe('file: a .pdf or .docx'),
      }),
      responses: {
        200: {
          description: 'Extracted',
          schema: z.object({ status: z.literal('ok'), source: ExtractedSourceViewSchema }),
        },
        413: { description: 'File too large', schema: ErrorBodySchema },
        415: { description: 'Not multipart/form-data', schema: ErrorBodySchema },
        422: { description: 'The file could not be extracted', schema: ErrorBodySchema },
        ...COMMON_ERRORS,
      },
      async handle({ c, body }) {
        const { file } = body;
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new ApiError(
            413,
            'too_large',
            `The file is larger than ${MAX_UPLOAD_BYTES} bytes.`,
          );
        }
        const result = await agent.request(
          'researchTools.extractUpload',
          {
            requestId: randomUUID(),
            name: basename(file.name.replace(/\\/g, '/')),
            contentBase64: Buffer.from(await file.arrayBuffer()).toString('base64'),
          },
          { timeoutMs: EXTRACT_TIMEOUT_MS },
        );
        if (result.status === 'error')
          throw new ApiError(422, result.error.code, result.error.message);
        return c.json(result);
      },
    }),
    route({
      method: 'post',
      path: '/storage/backup',
      tag: 'Storage',
      summary: 'Download a backup of the agent database',
      description:
        'Returns a consistent copy of the SQLite database as a file download (the desktop app ' +
        'uses a save dialog instead). The copy opens as a normal SQLite file.',
      responses: {
        200: { description: 'The database file', contentType: 'application/octet-stream' },
        ...COMMON_ERRORS,
      },
      async handle() {
        const snapshot = await agent.request(
          'storage.createSnapshot',
          {},
          { timeoutMs: 5 * 60_000 },
        );
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const chunk = await agent.request('storage.readSnapshot', {
              snapshotId: snapshot.snapshotId,
              offset,
              length: SNAPSHOT_CHUNK_BYTES,
            });
            if (!chunk) {
              controller.error(new Error('The backup snapshot expired.'));
              return;
            }
            const bytes = Buffer.from(chunk.dataBase64, 'base64');
            offset += bytes.length;
            if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes));
            if (chunk.eof) controller.close();
          },
        });
        return new Response(body, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(snapshot.sizeBytes),
            'content-disposition': `attachment; filename="${snapshot.fileName}"`,
            'cache-control': 'no-store',
          },
        });
      },
    }),
  ];
}
