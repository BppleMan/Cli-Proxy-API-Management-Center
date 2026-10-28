/**
 * 日志相关 API
 */

import type { ApiError } from '@/types';
import { apiClient } from './client';
import { parseApiErrorResponse } from './apiError';
import { LOGS_TIMEOUT_MS } from '@/utils/constants';
import { isRecord } from '@/utils/helpers';

export interface LogsQuery {
  after?: number;
  cursor?: string;
  limit?: number;
}

export interface LogsResponse {
  lines: string[];
  latestAfter?: number;
  nextCursor?: string;
  cursorReset?: boolean;
}

export interface ErrorLogFile {
  name: string;
  size?: number;
  modified?: number;
}

export interface ErrorLogsResponse {
  files: ErrorLogFile[];
}

export interface LocalRequestLog extends ErrorLogFile {
  requestId: string;
  size: number;
  modified: number;
}

export interface LocalLogStatus {
  usageAvailable: boolean;
  usedBytes: number;
  limitBytes: number;
  captureFailures: number;
  droppedChunks: number;
  lastFailure: number;
  diskTotalBytes: number;
  diskAvailableBytes: number;
  diskStatsAvailable: boolean;
}

export interface LocalLogPage {
  text: string;
  offset: number;
  nextOffset: number;
  size: number;
  media: Array<{ offset: number; mime: string }>;
}

const stringValue = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const booleanValue = (value: unknown): boolean =>
  value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');

const unixSecondsFromValue = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = stringValue(value);
  if (!text) return 0;
  const asNumber = Number(text);
  if (Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(text);
  return Number.isFinite(asDate) ? Math.floor(asDate / 1000) : 0;
};

const normalizeLogsResponse = (data: unknown): LogsResponse => {
  if (!isRecord(data)) {
    return { lines: [] };
  }

  const lines = Array.isArray(data.lines)
    ? data.lines.filter((line): line is string => typeof line === 'string')
    : [];
  const latestTimestamp = unixSecondsFromValue(data['latest-timestamp']);

  return {
    lines,
    latestAfter: latestTimestamp > 0 ? latestTimestamp : undefined,
    // An explicit empty cursor clears the previous cursor after a reset.
    nextCursor: typeof data['next-cursor'] === 'string' ? data['next-cursor'] : undefined,
    cursorReset: booleanValue(data['cursor-reset']),
  };
};

export interface LogsRequestOptions {
  signal?: AbortSignal;
}

const normalizeErrorLogsResponse = (data: unknown): ErrorLogsResponse => {
  if (!isRecord(data) || !Array.isArray(data.files)) return { files: [] };
  return {
    files: data.files.flatMap((file): ErrorLogFile[] => {
      if (!isRecord(file) || typeof file.name !== 'string' || !file.name.trim()) return [];
      return [
        {
          name: file.name,
          size:
            typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0
              ? file.size
              : undefined,
          modified: unixSecondsFromValue(file.modified) || undefined,
        },
      ];
    }),
  };
};

/** Decode download bodies without interpreting successful log contents as API errors. */
export const responseDataToText = async (data: unknown): Promise<string> => {
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (typeof data === 'string') return data;
  if (data === undefined || data === null) return '';
  try {
    return JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    return String(data);
  }
};

const downloadLog = async (path: string, options: LogsRequestOptions) => {
  try {
    return await apiClient.getRaw(path, {
      ...options,
      responseType: 'blob',
      timeout: LOGS_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    // The client already emitted unauthorized on 401 and normalized the Axios error.
    // It retains the body in data/details, NOT response.data. Preserve its identity,
    // status, transport code and body while enriching the human-readable error.
    if (error instanceof Error) {
      const apiError = error as ApiError;
      const body = apiError.data instanceof Blob ? apiError.data : apiError.details;
      if (body instanceof Blob) {
        try {
          const text = await responseDataToText(body);
          const parsed = parseApiErrorResponse(JSON.parse(text), apiError.message);
          apiError.message = parsed.message;
          if (parsed.apiCode !== undefined) apiError.apiCode = parsed.apiCode;
        } catch {
          // Unreadable/non-JSON bodies must not mask the original transport failure.
        }
      }
    }
    throw error;
  }
};

export const logsApi = {
  async fetchLogs(params: LogsQuery = {}, options: LogsRequestOptions = {}): Promise<LogsResponse> {
    const data = await apiClient.get('/observability/logs', {
      ...options,
      params,
      timeout: LOGS_TIMEOUT_MS,
    });
    return normalizeLogsResponse(data);
  },

  clearLogs: (options: LogsRequestOptions = {}) => apiClient.delete('/observability/logs', options),

  async fetchErrorLogs(options: LogsRequestOptions = {}): Promise<ErrorLogsResponse> {
    const data = await apiClient.get('/observability/logs/errors', {
      ...options,
      timeout: LOGS_TIMEOUT_MS,
    });
    return normalizeErrorLogsResponse(data);
  },

  downloadErrorLog: (filename: string, options: LogsRequestOptions = {}) =>
    downloadLog(`/observability/logs/errors/${encodeURIComponent(filename)}`, options),

  downloadRequestLogById: (id: string, options: LogsRequestOptions = {}) =>
    downloadLog(`/observability/logs/requests/${encodeURIComponent(id)}`, options),

  async fetchLocalRequestLogs(
    params: { q?: string; after?: number; before?: number; cursor?: string } = {}
  ) {
    const data = await apiClient.get('/observability/logs/local-requests', { params });
    if (!isRecord(data) || !Array.isArray(data.files)) return { files: [], nextCursor: '' };
    return {
      files: data.files.flatMap((item): LocalRequestLog[] => {
        if (!isRecord(item) || typeof item.name !== 'string') return [];
        return [
          {
            name: item.name,
            requestId: stringValue(item.request_id),
            size: typeof item.size === 'number' ? item.size : 0,
            modified: unixSecondsFromValue(item.modified),
          },
        ];
      }),
      nextCursor: stringValue(data.next_cursor),
    };
  },

  async fetchLocalLogPage(name: string, offset = 0): Promise<LocalLogPage> {
    const data = await apiClient.get(
      `/observability/logs/local-requests/${encodeURIComponent(name)}/preview`,
      {
        params: { offset },
      }
    );
    if (!isRecord(data) || typeof data.data !== 'string') throw new Error('Invalid log page');
    const bytes = Uint8Array.from(atob(data.data), (character) => character.charCodeAt(0));
    return {
      text: new TextDecoder().decode(bytes),
      offset: typeof data.offset === 'number' ? data.offset : 0,
      nextOffset: typeof data.next_offset === 'number' ? data.next_offset : 0,
      size: typeof data.size === 'number' ? data.size : 0,
      media: Array.isArray(data.media)
        ? data.media.flatMap((item) =>
            isRecord(item) && typeof item.offset === 'number' && typeof item.mime === 'string'
              ? [{ offset: item.offset, mime: item.mime }]
              : []
          )
        : [],
    };
  },

  async fetchLocalLogStatus(): Promise<LocalLogStatus> {
    const data = await apiClient.get('/observability/logs/local-status');
    if (!isRecord(data)) throw new Error('Invalid log status');
    const number = (value: unknown) => (typeof value === 'number' ? value : 0);
    return {
      usedBytes: number(data.used_bytes),
      usageAvailable: data.usage_available !== false,
      limitBytes: number(data.limit_bytes),
      captureFailures: number(data.capture_failures),
      droppedChunks: number(data.dropped_chunks),
      lastFailure: number(data.last_failure),
      diskTotalBytes: number(data.disk_total_bytes),
      diskAvailableBytes: number(data.disk_available_bytes),
      diskStatsAvailable: data.disk_stats_available === true,
    };
  },

  downloadLocalRequestLog: (name: string, options: LogsRequestOptions = {}) =>
    downloadLog(`/observability/logs/local-requests/${encodeURIComponent(name)}/download`, options),

  downloadLocalLogMedia: (name: string, offset: number, options: LogsRequestOptions = {}) =>
    downloadLog(
      `/observability/logs/local-requests/${encodeURIComponent(name)}/media?offset=${offset}`,
      options
    ),
};
