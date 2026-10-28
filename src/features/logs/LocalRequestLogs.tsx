import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import {
  logsApi,
  type LocalLogPage,
  type LocalLogStatus,
  type LocalRequestLog,
} from '@/services/api/logs';
import { useAuthStore, useNotificationStore } from '@/stores';
import { downloadBlob } from '@/utils/download';
import { formatUnixTimestamp } from '@/utils/format';
import { getErrorMessage } from '@/utils/helpers';
import styles from './LogsPage.module.scss';

interface Filters {
  q: string;
  after?: number;
  before?: number;
}

const asSeconds = (value: string): number | undefined => {
  const result = Date.parse(value);
  return Number.isFinite(result) ? Math.floor(result / 1000) : undefined;
};

export function LocalRequestLogs() {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const connection = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const [query, setQuery] = useState('');
  const [after, setAfter] = useState('');
  const [before, setBefore] = useState('');
  const [filters, setFilters] = useState<Filters>({ q: '' });
  const [cursor, setCursor] = useState('');
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState('');
  const [files, setFiles] = useState<LocalRequestLog[]>([]);
  const [status, setStatus] = useState<LocalLogStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<LocalRequestLog | null>(null);
  const [page, setPage] = useState<LocalLogPage | null>(null);
  const [pageHistory, setPageHistory] = useState<number[]>([]);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [media, setMedia] = useState<{ url: string; mime: string } | null>(null);
  const generation = useRef(0);
  const pageGeneration = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    if (connection !== 'connected') return;
    setLoading(true);
    setError('');
    Promise.all([
      logsApi.fetchLocalRequestLogs({ ...filters, cursor: cursor || undefined }),
      logsApi.fetchLocalLogStatus(),
    ])
      .then(([response, nextStatus]) => {
        if (generation.current !== current) return;
        setFiles(response.files);
        setNextCursor(response.nextCursor);
        setStatus(nextStatus);
      })
      .catch((err: unknown) => {
        if (generation.current === current) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generation.current += 1;
    };
  }, [apiBase, connection, managementKey, filters, cursor, revision]);

  useEffect(
    () => () => {
      pageGeneration.current += 1;
    },
    [apiBase, managementKey]
  );
  useEffect(
    () => () => {
      if (media) URL.revokeObjectURL(media.url);
    },
    [media]
  );

  const loadPage = async (item: LocalRequestLog, offset: number) => {
    const current = ++pageGeneration.current;
    setPageLoading(true);
    setPageError('');
    setMedia(null);
    try {
      const result = await logsApi.fetchLocalLogPage(item.name, offset);
      if (pageGeneration.current === current) setPage(result);
    } catch (err: unknown) {
      if (pageGeneration.current === current) setPageError(getErrorMessage(err));
    } finally {
      if (pageGeneration.current === current) setPageLoading(false);
    }
  };

  const download = async (item: LocalRequestLog) => {
    const current = generation.current;
    try {
      const response = await logsApi.downloadLocalRequestLog(item.name);
      if (generation.current !== current) return;
      downloadBlob({
        filename: item.name,
        blob: new Blob([response.data], { type: 'text/plain' }),
      });
    } catch (err: unknown) {
      if (generation.current === current) showNotification(getErrorMessage(err), 'error');
    }
  };

  const applyFilters = () => {
    setCursor('');
    setCursorHistory([]);
    setFilters({ q: query.trim(), after: asSeconds(after), before: asSeconds(before) });
  };

  const loadMedia = async (
    item: LocalRequestLog,
    ref: { offset: number; mime: string },
    preview: boolean
  ) => {
    const current = pageGeneration.current;
    try {
      const response = await logsApi.downloadLocalLogMedia(item.name, ref.offset);
      if (pageGeneration.current !== current) return;
      const blob =
        response.data instanceof Blob
          ? response.data
          : new Blob([response.data], { type: ref.mime });
      if (preview) setMedia({ url: URL.createObjectURL(blob), mime: ref.mime });
      else downloadBlob({ filename: `media-${ref.offset}.${ref.mime.split('/')[1]}`, blob });
    } catch (err: unknown) {
      if (pageGeneration.current === current) setPageError(getErrorMessage(err));
    }
  };

  const closeViewer = () => {
    pageGeneration.current += 1;
    setSelected(null);
    setPage(null);
    setPageHistory([]);
    setMedia(null);
  };

  const clearLocalLogs = () => {
    const current = generation.current;
    showConfirmation({
      title: t('logs.clear_button'),
      message: t('logs.local_clear_confirm'),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        if (generation.current !== current) return;
        try {
          await logsApi.clearLogs();
          if (generation.current !== current) return;
          closeViewer();
          setCursor('');
          setCursorHistory([]);
          setRevision((value) => value + 1);
        } catch (err: unknown) {
          if (generation.current === current) showNotification(getErrorMessage(err), 'error');
        }
      },
    });
  };

  return (
    <Card title={t('logs.local_title')}>
      <div className={styles.errorBody}>
        {status && (
          <div className="hint">
            {t('logs.local_usage', {
              used: (status.usedBytes / 1024 ** 3).toFixed(2),
              limit: (status.limitBytes / 1024 ** 3).toFixed(2),
            })}
            {status.limitBytes > 0 && status.usedBytes >= status.limitBytes * 0.9 && (
              <div className="status-badge warning">{t('logs.local_capacity_warning')}</div>
            )}
            {(status.captureFailures > 0 || status.droppedChunks > 0) && (
              <div className="status-badge warning">
                {t('logs.local_capture_warning', {
                  failures: status.captureFailures,
                  drops: status.droppedChunks,
                })}
              </div>
            )}
          </div>
        )}
        <Input
          label={t('logs.local_search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Input
          label={t('logs.local_after')}
          type="datetime-local"
          value={after}
          onChange={(event) => setAfter(event.target.value)}
        />
        <Input
          label={t('logs.local_before')}
          type="datetime-local"
          value={before}
          onChange={(event) => setBefore(event.target.value)}
        />
        <div className="item-actions">
          <Button size="sm" onClick={applyFilters}>
            {t('logs.local_search_action')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setRevision((value) => value + 1)}
            loading={loading}
          >
            {t('common.refresh')}
          </Button>
          <Button size="sm" variant="danger" onClick={clearLocalLogs}>
            {t('logs.clear_button')}
          </Button>
        </div>
        {error && <div className="error-box">{error}</div>}
        {!loading && !error && files.length === 0 && (
          <div className="hint">{t('logs.local_empty')}</div>
        )}
        <div className="item-list">
          {files.map((item) => (
            <div className="item-row" key={item.name}>
              <div className="item-meta">
                <div className="item-title">{item.requestId || item.name}</div>
                <div className="item-subtitle">
                  {formatUnixTimestamp(item.modified)} · {(item.size / 1024 / 1024).toFixed(2)} MiB
                </div>
              </div>
              <div className="item-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setSelected(item);
                    setPageHistory([]);
                    void loadPage(item, 0);
                  }}
                >
                  {t('logs.error_logs_open')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void download(item);
                  }}
                >
                  {t('logs.error_logs_download')}
                </Button>
              </div>
            </div>
          ))}
        </div>
        <div className="item-actions">
          <Button
            size="sm"
            variant="secondary"
            disabled={!cursorHistory.length || loading}
            onClick={() => {
              setCursor(cursorHistory[cursorHistory.length - 1] ?? '');
              setCursorHistory(cursorHistory.slice(0, -1));
            }}
          >
            {t('logs.local_previous')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!nextCursor || loading}
            onClick={() => {
              setCursorHistory([...cursorHistory, cursor]);
              setCursor(nextCursor);
            }}
          >
            {t('logs.local_next')}
          </Button>
        </div>
      </div>
      <Modal
        open={selected !== null}
        title={selected?.requestId || selected?.name}
        onClose={closeViewer}
        width={960}
        footer={
          <>
            <Button variant="secondary" onClick={closeViewer}>
              {t('common.close')}
            </Button>
            <Button
              variant="secondary"
              disabled={!pageHistory.length || pageLoading}
              onClick={() => {
                if (!selected) return;
                const previous = pageHistory[pageHistory.length - 1] ?? 0;
                setPageHistory(pageHistory.slice(0, -1));
                void loadPage(selected, previous);
              }}
            >
              {t('logs.local_previous')}
            </Button>
            <Button
              variant="secondary"
              disabled={!page || page.nextOffset >= page.size || pageLoading}
              onClick={() => {
                if (!selected || !page) return;
                setPageHistory([...pageHistory, page.offset]);
                void loadPage(selected, page.nextOffset);
              }}
            >
              {t('logs.local_next')}
            </Button>
            <Button
              disabled={!selected}
              onClick={() => {
                if (selected) void download(selected);
              }}
            >
              {t('logs.error_logs_download')}
            </Button>
          </>
        }
      >
        {pageError && <div className="error-box">{pageError}</div>}
        {pageLoading && <div className="hint">{t('common.loading')}</div>}
        {page && (
          <>
            <div className="hint">
              {t('logs.local_page_position', {
                start: page.offset,
                end: page.nextOffset,
                size: page.size,
              })}
            </div>
            {selected &&
              page.media.map((ref) => (
                <div className="item-actions" key={ref.offset}>
                  <span>{ref.mime}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void loadMedia(selected, ref, true);
                    }}
                  >
                    {t('logs.local_media_preview')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void loadMedia(selected, ref, false);
                    }}
                  >
                    {t('logs.local_media_download')}
                  </Button>
                </div>
              ))}
            {media?.mime.startsWith('image/') && (
              <img
                src={media.url}
                alt={t('logs.local_media_preview')}
                style={{ maxWidth: '100%', maxHeight: 420 }}
              />
            )}
            {media?.mime.startsWith('audio/') && <audio src={media.url} controls />}
            {media?.mime.startsWith('video/') && (
              <video src={media.url} controls style={{ maxWidth: '100%', maxHeight: 420 }} />
            )}
            <pre className={styles.errorLogContent} spellCheck={false}>
              {page.text}
            </pre>
          </>
        )}
      </Modal>
    </Card>
  );
}
