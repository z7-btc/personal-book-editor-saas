'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ApiError, booksApi, type ProfileView } from './api';

const EMPTY: ProfileView = {
  about_me: '',
  reading_goal: '',
  preferred_style: [],
  disliked_style: [],
  known_topics: [],
  weak_topics: [],
  explanation_preferences: [],
  language_preferences: [],
  custom_instructions: '',
};

type ListField =
  | 'preferred_style'
  | 'disliked_style'
  | 'known_topics'
  | 'weak_topics'
  | 'explanation_preferences'
  | 'language_preferences';

const LIST_FIELDS: ListField[] = [
  'preferred_style',
  'disliked_style',
  'known_topics',
  'weak_topics',
  'explanation_preferences',
  'language_preferences',
];

export default function ProfileClient() {
  const t = useTranslations('Books');
  const [loaded, setLoaded] = useState<ProfileView | null>(null);
  const [draft, setDraft] = useState<ProfileView>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await booksApi.profile();
      const profile = { ...EMPTY, ...data.profile };
      for (const key of LIST_FIELDS) {
        if (!Array.isArray(profile[key])) profile[key] = [];
      }
      setLoaded(profile);
      setDraft(profile);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const dirty = useMemo(() => {
    if (!loaded) return false;
    return JSON.stringify(loaded) !== JSON.stringify(draft);
  }, [loaded, draft]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const data = await booksApi.saveProfile(draft);
      const profile = { ...EMPTY, ...data.profile };
      for (const key of LIST_FIELDS) {
        if (!Array.isArray(profile[key])) profile[key] = [];
      }
      setLoaded(profile);
      setDraft(profile);
      setMessage(t('profile.saved'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setSaving(false);
    }
  }

  const input =
    'w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-gray-400 dark:border-gray-700 dark:focus:border-gray-500';
  const label = 'text-xs font-medium text-gray-600 dark:text-gray-400';

  function setText(key: 'about_me' | 'reading_goal' | 'custom_instructions', value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function setList(key: ListField, raw: string) {
    const items = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    setDraft((prev) => ({ ...prev, [key]: items }));
  }

  if (!loaded) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{t('profile.title')}</h1>
          {dirty && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              {t('profile.dirty')}
            </span>
          )}
        </div>
        <p className="max-w-3xl text-sm text-gray-600 dark:text-gray-400">{t('profile.subtitle')}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('profile.hint')}</p>
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

      <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="space-y-4">
          <label className="block space-y-1">
            <span className={label}>{t('profile.fields.about_me')}</span>
            <textarea
              value={draft.about_me}
              onChange={(event) => setText('about_me', event.target.value)}
              rows={4}
              placeholder={t('profile.placeholders.about_me')}
              className={input}
            />
          </label>
          <label className="block space-y-1">
            <span className={label}>{t('profile.fields.reading_goal')}</span>
            <textarea
              value={draft.reading_goal}
              onChange={(event) => setText('reading_goal', event.target.value)}
              rows={3}
              placeholder={t('profile.placeholders.reading_goal')}
              className={input}
            />
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="grid gap-4 md:grid-cols-2">
          {LIST_FIELDS.map((key) => (
            <label key={key} className="block space-y-1">
              <span className={label}>{t(`profile.fields.${key}`)}</span>
              <textarea
                value={(draft[key] || []).join('\n')}
                onChange={(event) => setList(key, event.target.value)}
                rows={4}
                placeholder={t('profile.hint')}
                className={input}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <label className="block space-y-1">
          <span className={label}>{t('profile.fields.custom_instructions')}</span>
          <textarea
            value={draft.custom_instructions}
            onChange={(event) => setText('custom_instructions', event.target.value)}
            rows={4}
            placeholder={t('profile.placeholders.custom_instructions')}
            className={input}
          />
        </label>
      </section>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button
          type="button"
          onClick={() => setDraft(loaded)}
          disabled={!dirty}
          className="rounded-md border border-gray-200 px-3.5 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          {t('profile.discard')}
        </button>
      </div>
    </div>
  );
}
