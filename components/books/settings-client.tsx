'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ApiError,
  booksApi,
  formatDate,
  type ProviderPreset,
  type ProviderView,
  type SettingsPayload,
} from './api';

type ProviderForm = {
  id?: string;
  presetId: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyEnv: string;
  maxTokens: string;
  temperature: string;
  timeoutMs: string;
  maxInputChars: string;
  reasoningEffort: string;
};

const EMPTY_FORM: ProviderForm = {
  presetId: '',
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  apiKeyEnv: '',
  maxTokens: '8000',
  temperature: '0.3',
  timeoutMs: '300000',
  maxInputChars: '60000',
  reasoningEffort: 'none',
};

export default function SettingsClient() {
  const t = useTranslations('Books');
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<SettingsPayload['settings'] | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string }>>({});

  const load = useCallback(async () => {
    try {
      const [settingsData, providerData] = await Promise.all([booksApi.settings(), booksApi.providers()]);
      setData(settingsData);
      setDraft(settingsData.settings);
      setProviders(providerData.providers);
      setActiveId(providerData.activeId);
      setPresets(providerData.presets);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const currentSpeed = data?.currentSpeedPreset ?? 'balanced';

  function patch(path: string[], value: unknown) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as Record<string, unknown>;
      let cursor: Record<string, unknown> = next;
      for (const key of path.slice(0, -1)) {
        const child = cursor[key];
        if (!child || typeof child !== 'object') cursor[key] = {};
        cursor = cursor[key] as Record<string, unknown>;
      }
      cursor[path[path.length - 1]] = value;
      return next as SettingsPayload['settings'];
    });
  }

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const result = await booksApi.saveSettings(draft as Record<string, unknown>);
      setMessage(t('settings.savedToast'));
      setDraft(result.settings as SettingsPayload['settings']);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setSaving(false);
    }
  }

  function openCreate() {
    setForm({ ...EMPTY_FORM });
    setError('');
  }

  function openEdit(provider: ProviderView) {
    setForm({
      id: provider.id,
      presetId: String(provider.presetId || ''),
      name: String(provider.name || ''),
      baseUrl: String(provider.baseUrl || ''),
      model: String(provider.model || ''),
      apiKey: '',
      apiKeyEnv: String(provider.apiKeyEnv || ''),
      maxTokens: String(provider.maxTokens ?? 8000),
      temperature: String(provider.temperature ?? 0.3),
      timeoutMs: String(provider.timeoutMs ?? 300000),
      maxInputChars: String(provider.maxInputChars ?? 60000),
      reasoningEffort: String(provider.reasoningEffort ?? 'none'),
    });
    setError('');
  }

  function applyPreset(presetId: string) {
    const preset = presets.find((p) => p.id === presetId);
    setForm((prev) => {
      if (!prev) return prev;
      if (!preset) return { ...prev, presetId };
      return {
        ...prev,
        presetId,
        name: preset.name,
        baseUrl: preset.baseUrl,
        model: preset.model,
        apiKeyEnv: preset.apiKeyEnv || '',
      };
    });
  }

  async function submitProvider() {
    if (!form) return;
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) {
      setError(t('settings.providers.required'));
      return;
    }
    setBusyProvider('form');
    setError('');
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        apiKeyEnv: form.apiKeyEnv.trim(),
        maxTokens: Number(form.maxTokens) || 8000,
        temperature: Number(form.temperature),
        timeoutMs: Number(form.timeoutMs) || 300000,
        maxInputChars: Number(form.maxInputChars) || 0,
        reasoningEffort: form.reasoningEffort,
        presetId: form.presetId,
      };
      // 编辑时留空 = 保留原来的 Key（服务端约定：__KEEP__）
      payload.apiKey = form.apiKey ? form.apiKey : form.id ? '__KEEP__' : '';
      if (form.id) await booksApi.updateProvider(form.id, payload);
      else await booksApi.createProvider(payload);
      setForm(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusyProvider(null);
    }
  }

  async function providerAction(id: string, action: 'activate' | 'test' | 'delete') {
    setBusyProvider(id);
    setError('');
    try {
      if (action === 'activate') {
        await booksApi.activateProvider(id);
        await load();
      } else if (action === 'delete') {
        const provider = providers.find((p) => p.id === id);
        if (!window.confirm(t('settings.providers.deleteConfirm', { name: provider?.name || id }))) return;
        await booksApi.deleteProvider(id);
        await load();
      } else {
        const result = await booksApi.testProvider(id);
        const ok = result.result.ok !== false && !result.result.error;
        setTestResult((prev) => ({
          ...prev,
          [id]: {
            ok,
            text: ok
              ? t('settings.providers.testOk', { latency: result.result.latencyMs ?? 0 })
              : result.result.error || t('settings.providers.testFail'),
          },
        }));
      }
    } catch (err) {
      const text = err instanceof ApiError ? err.message : t('common.error');
      if (action === 'test') setTestResult((prev) => ({ ...prev, [id]: { ok: false, text } }));
      else setError(text);
    } finally {
      setBusyProvider(null);
    }
  }

  const presetLabel = useMemo(
    () => (preset: ProviderPreset) => {
      if (preset.id === 'custom') return t('settings.providers.presetCustom');
      if (preset.id === 'ollama') return t('settings.providers.presetOllama');
      if (preset.id === 'lmstudio') return t('settings.providers.presetLmStudio');
      return preset.name;
    },
    [t],
  );

  if (!data || !draft) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>;
  }

  const input = 'w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-gray-400 dark:border-gray-700 dark:focus:border-gray-500';
  const label = 'text-xs font-medium text-gray-600 dark:text-gray-400';
  const section = 'rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900';
  const button = 'rounded-md border border-gray-200 px-3 py-1.5 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800';
  const primary =
    'rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white';

  const num = (path: string[], fallback: number) => Number(read(draft, path) ?? fallback);
  const bool = (path: string[], fallback: boolean) => Boolean(read(draft, path) ?? fallback);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('settings.subtitle')}</p>
      </header>

      {message && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          {message}
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {/* ------------------------------------------------------ Providers -- */}
      <section className={section}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t('settings.providers.title')}</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('settings.providers.desc')}</p>
          </div>
          <button type="button" onClick={openCreate} className={primary}>
            {t('settings.providers.add')}
          </button>
        </div>

        {providers.length === 0 ? (
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">{t('settings.providers.empty')}</p>
        ) : (
          <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
            {providers.map((provider) => {
              const isActive = provider.id === activeId;
              const test = testResult[provider.id];
              const lastTest = provider.lastTest;
              return (
                <li key={provider.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{provider.name || provider.id}</span>
                    {isActive && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        {t('settings.providers.activeBadge')}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] ${
                        provider.hasApiKey
                          ? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                      }`}
                    >
                      {provider.apiKeySource === 'env'
                        ? t('settings.providers.keyFromEnv')
                        : provider.hasApiKey
                          ? t('settings.providers.keyConfigured')
                          : t('settings.providers.keyMissing')}
                    </span>
                  </div>

                  <p className="mt-1 break-all text-xs text-gray-500 dark:text-gray-400">
                    {provider.baseUrl || '—'} · {provider.model || t('settings.providers.noModel')} ·{' '}
                    {provider.maxTokens ?? '—'} · T={provider.temperature ?? '—'}
                  </p>

                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {lastTest?.at
                      ? t('settings.providers.lastTest', {
                          latency: lastTest.latencyMs ?? 0,
                          model: lastTest.model || provider.model || '—',
                        })
                      : t('settings.providers.lastTestNever')}
                  </p>

                  {test && (
                    <p
                      className={`mt-1 text-xs ${
                        test.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {test.text}
                    </p>
                  )}

                  <div className="mt-2 flex flex-wrap gap-2">
                    {!isActive && (
                      <button
                        type="button"
                        onClick={() => providerAction(provider.id, 'activate')}
                        disabled={busyProvider === provider.id}
                        className={button}
                      >
                        {t('settings.providers.use')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => providerAction(provider.id, 'test')}
                      disabled={busyProvider === provider.id}
                      className={button}
                    >
                      {busyProvider === provider.id ? t('settings.providers.testing') : t('settings.providers.test')}
                    </button>
                    <button type="button" onClick={() => openEdit(provider)} className={button}>
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => providerAction(provider.id, 'delete')}
                      disabled={busyProvider === provider.id}
                      className={`${button} text-red-600 dark:text-red-400`}
                    >
                      {t('settings.providers.delete')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {form && (
          <div className="mt-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <h3 className="text-sm font-semibold">
              {form.id ? t('settings.providers.editTitle') : t('settings.providers.addTitle')}
            </h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className={label}>{t('settings.providers.preset')}</span>
                <select
                  value={form.presetId}
                  onChange={(event) => applyPreset(event.target.value)}
                  className={input}
                >
                  <option value="">—</option>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {presetLabel(preset)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className={label}>{t('settings.providers.name')}</span>
                <input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  className={input}
                />
              </label>
              <label className="space-y-1 sm:col-span-2">
                <span className={label}>{t('settings.providers.baseUrl')}</span>
                <input
                  value={form.baseUrl}
                  onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                  placeholder="https://api.example.com/v1"
                  className={input}
                />
              </label>
              <label className="space-y-1">
                <span className={label}>{t('settings.providers.model')}</span>
                <input
                  value={form.model}
                  onChange={(event) => setForm({ ...form, model: event.target.value })}
                  className={input}
                />
              </label>
              <label className="space-y-1">
                <span className={label}>{t('settings.providers.apiKey')}</span>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  placeholder={form.id ? t('settings.providers.apiKeyKeep') : ''}
                  autoComplete="off"
                  className={input}
                />
              </label>
            </div>

            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400">
                {t('settings.providers.advanced')}
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="space-y-1">
                  <span className={label}>{t('settings.providers.maxTokens')}</span>
                  <input
                    type="number"
                    value={form.maxTokens}
                    onChange={(event) => setForm({ ...form, maxTokens: event.target.value })}
                    className={input}
                  />
                </label>
                <label className="space-y-1">
                  <span className={label}>{t('settings.providers.temperature')}</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={form.temperature}
                    onChange={(event) => setForm({ ...form, temperature: event.target.value })}
                    className={input}
                  />
                </label>
                <label className="space-y-1">
                  <span className={label}>{t('settings.providers.timeoutMs')}</span>
                  <input
                    type="number"
                    value={form.timeoutMs}
                    onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })}
                    className={input}
                  />
                </label>
                <label className="space-y-1">
                  <span className={label}>{t('settings.providers.maxInputChars')}</span>
                  <input
                    type="number"
                    value={form.maxInputChars}
                    onChange={(event) => setForm({ ...form, maxInputChars: event.target.value })}
                    className={input}
                  />
                </label>
                <label className="space-y-1">
                  <span className={label}>{t('settings.providers.reasoningEffort')}</span>
                  <select
                    value={form.reasoningEffort}
                    onChange={(event) => setForm({ ...form, reasoningEffort: event.target.value })}
                    className={input}
                  >
                    <option value="">—</option>
                    <option value="none">none</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className={label}>{t('settings.providers.apiKeyEnv')}</span>
                  <input
                    value={form.apiKeyEnv}
                    onChange={(event) => setForm({ ...form, apiKeyEnv: event.target.value })}
                    placeholder="OPENAI_API_KEY"
                    className={input}
                  />
                </label>
              </div>
            </details>

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={submitProvider} disabled={busyProvider === 'form'} className={primary}>
                {t('common.save')}
              </button>
              <button type="button" onClick={() => setForm(null)} className={button}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------ 处理方式 -- */}
      <section className={section}>
        <h2 className="text-lg font-semibold">{t('settings.speed.title')}</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('settings.speed.desc')}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {data.speedPresets.map((preset) => {
            const checked = preset.id === currentSpeed;
            const labelKey =
              preset.id === 'careful' ? 'careful' : preset.id === 'frugal' ? 'frugal' : 'balanced';
            const hintKey = `${labelKey}Hint` as 'carefulHint' | 'balancedHint' | 'frugalHint';
            return (
              <label
                key={preset.id}
                className={`cursor-pointer rounded-lg border p-3 text-sm ${
                  checked ? 'border-gray-900 bg-gray-50 dark:border-gray-300 dark:bg-gray-800' : 'border-gray-200 dark:border-gray-700'
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="speed"
                    checked={checked}
                    onChange={() => {
                      patch(['processing', 'targetCharsPerChunk'], preset.target);
                      patch(['processing', 'maxCharsPerChunk'], preset.max);
                    }}
                  />
                  <span className="font-medium">{t(`settings.speed.${labelKey}`)}</span>
                </span>
                <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                  {t(`settings.speed.${hintKey}`)}
                </span>
                <span className="mt-1 block text-[11px] text-gray-400">
                  {preset.target} / {preset.max}
                </span>
              </label>
            );
          })}
        </div>
      </section>

      {/* --------------------------------------------------------- 行为 -- */}
      <section className={section}>
        <h2 className="text-lg font-semibold">{t('settings.options.title')}</h2>
        <div className="mt-3 space-y-3 text-sm">
          <Toggle
            checked={bool(['memory', 'enabled'], true)}
            onChange={(value) => patch(['memory', 'enabled'], value)}
            title={t('settings.options.memory')}
            desc={t('settings.options.memoryDesc')}
          />
          <Toggle
            checked={bool(['processing', 'explainPass'], true)}
            onChange={(value) => patch(['processing', 'explainPass'], value)}
            title={t('settings.options.explain')}
            desc={t('settings.options.explainDesc')}
          />
          <Toggle
            checked={bool(['review', 'enabled'], false)}
            onChange={(value) => patch(['review', 'enabled'], value)}
            title={t('settings.options.quality')}
            desc={t('settings.options.qualityDesc')}
          />

          {bool(['review', 'enabled'], false) && (
            <label className="block space-y-1">
              <span className={label}>{t('settings.options.reviewProvider')}</span>
              <select
                value={String(read(draft, ['review', 'providerId']) ?? '')}
                onChange={(event) => patch(['review', 'providerId'], event.target.value || null)}
                className={input}
              >
                <option value="">{t('settings.options.reviewProviderSame')}</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name || provider.id}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </section>

      {/* --------------------------------------------------------- 高级 -- */}
      <section className={section}>
        <details>
          <summary className="cursor-pointer text-lg font-semibold">{t('settings.advanced.title')}</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <NumberField
              label={t('settings.advanced.concurrency')}
              value={num(['processing', 'concurrentChapters'], 1)}
              onChange={(value) => patch(['processing', 'concurrentChapters'], value)}
              min={1}
              max={8}
              input={input}
              labelClass={label}
            />
            <NumberField
              label={t('settings.advanced.maxRetries')}
              value={num(['processing', 'maxRetries'], 3)}
              onChange={(value) => patch(['processing', 'maxRetries'], value)}
              min={0}
              max={10}
              input={input}
              labelClass={label}
            />
            <NumberField
              label={t('settings.advanced.retryBaseDelay')}
              value={num(['processing', 'retryBaseDelayMs'], 2000)}
              onChange={(value) => patch(['processing', 'retryBaseDelayMs'], value)}
              min={0}
              input={input}
              labelClass={label}
            />
            <NumberField
              label={t('settings.advanced.chapterPause')}
              value={num(['processing', 'chapterPauseMs'], 300)}
              onChange={(value) => patch(['processing', 'chapterPauseMs'], value)}
              min={0}
              input={input}
              labelClass={label}
            />
            <NumberField
              label={t('settings.advanced.minLengthRatio')}
              value={num(['quality', 'minLengthRatio'], 0.45)}
              onChange={(value) => patch(['quality', 'minLengthRatio'], value)}
              step="0.05"
              min={0}
              max={3}
              input={input}
              labelClass={label}
            />
            <NumberField
              label={t('settings.advanced.maxLengthRatio')}
              value={num(['quality', 'maxLengthRatio'], 2.2)}
              onChange={(value) => patch(['quality', 'maxLengthRatio'], value)}
              step="0.1"
              min={0}
              max={10}
              input={input}
              labelClass={label}
            />
            <NumberField
              label={t('settings.advanced.failLengthRatio')}
              value={num(['quality', 'failLengthRatio'], 0.25)}
              onChange={(value) => patch(['quality', 'failLengthRatio'], value)}
              step="0.05"
              min={0}
              max={3}
              input={input}
              labelClass={label}
            />
            <NumberField
              label={t('settings.advanced.numberKeepRatio')}
              value={num(['quality', 'numberKeepRatio'], 0.85)}
              onChange={(value) => patch(['quality', 'numberKeepRatio'], value)}
              step="0.05"
              min={0}
              max={1}
              input={input}
              labelClass={label}
            />
            <NumberField
              label={t('settings.advanced.entityKeepRatio')}
              value={num(['quality', 'entityKeepRatio'], 0.8)}
              onChange={(value) => patch(['quality', 'entityKeepRatio'], value)}
              step="0.05"
              min={0}
              max={1}
              input={input}
              labelClass={label}
            />
            <NumberField
              label={t('settings.advanced.maxQualityRetries')}
              value={num(['quality', 'maxQualityRetries'], 1)}
              onChange={(value) => patch(['quality', 'maxQualityRetries'], value)}
              min={0}
              max={5}
              input={input}
              labelClass={label}
            />
            <div className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                id="auto-retry"
                type="checkbox"
                checked={bool(['quality', 'autoRetryOnFail'], true)}
                onChange={(event) => patch(['quality', 'autoRetryOnFail'], event.target.checked)}
              />
              <label htmlFor="auto-retry">{t('settings.advanced.autoRetry')}</label>
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <p className={label}>{t('settings.advanced.workspace')}</p>
              <p className="mt-1 break-all rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                {data.workspace}
              </p>
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">{t('settings.advanced.workspaceFixed')}</p>
            </div>
          </div>
        </details>
      </section>

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={saving} className={primary}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <span className="text-xs text-gray-500 dark:text-gray-400">{formatDate(new Date().toISOString(), 'en')}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 小部件 -- */

function read(source: unknown, path: string[]): unknown {
  let cursor: unknown = source;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function Toggle({
  checked,
  onChange,
  title,
  desc,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  desc: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1" />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">{desc}</span>
      </span>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  input,
  labelClass,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: string;
  input: string;
  labelClass: string;
}) {
  return (
    <label className="space-y-1">
      <span className={labelClass}>{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className={input}
      />
    </label>
  );
}
