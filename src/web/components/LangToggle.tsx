import { t, useLang } from '../i18n';

export function LangToggle() {
  const [lang, setLang] = useLang();
  return (
    <button
      type="button"
      class="lang"
      data-testid="lang-toggle"
      aria-label={t('langToggleLabel')}
      onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
    >
      {t('langToggle')}
    </button>
  );
}
