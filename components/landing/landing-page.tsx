import { Fragment } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ArrowDown,
  ArrowRight,
  BookOpen,
  ChevronDown,
  Clock,
  Download,
  FileText,
  GitCompare,
  Layers,
  List,
  ListChecks,
  ShieldCheck,
  SlidersVertical,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { hasLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { EmailCenterWidget } from '@/components/email-center/widget-loader';
import { siteOrigin } from '@/lib/seo';
import s from './landing.module.css';

/**
 * 未登录/已登录都看的首页落地页。
 *
 * 结构与文案来自旧项目 public/js/views-public.js 的九个区块（hero → pain
 * → features → output → profile → control → how → faq → finalCta），
 * 每一块回答一个问题；样式在 landing.module.css 里逐条移植。
 * 只改了两处产品事实：订阅价与模型费用分离（见 priceNote / faq5），
 * 以及页脚链接指向本站的实际页面。
 */
export async function LandingPage() {
  const t = await getTranslations('Landing');
  const seo = await getTranslations('Seo');
  const requested = await getLocale();
  // The page-level guard already ran, but narrowing here is what lets the
  // widget receive the `Locale` union instead of a bare string.
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  // H1 的「|」是设计好的换行点：交给浏览器自动断行时中文会在词中间裂开。
  const headline = t('h1').split('|');

  const compareBefore = [t('before1'), t('before2'), t('before3'), t('before4')];
  const compareAfter = [
    { num: '01', text: t('after1'), tag: t('tagCoreDeep'), kind: s.tagDeep as string },
    { num: '02', text: t('after2'), tag: t('tagDigest'), kind: s.tagDigest as string },
    { num: '03', text: t('after3'), tag: t('tagKeepAsIs'), kind: s.tagKeep as string },
  ];
  const outputPoints = [
    { icon: FileText, title: t('output1Title'), body: t('output1Body') },
    { icon: List, title: t('output2Title'), body: t('output2Body') },
    { icon: Layers, title: t('output3Title'), body: t('output3Body') },
  ];
  const mockChapters = [
    { num: '01', title: t('mock1Title'), body: t('mock1Body') },
    { num: '02', title: t('mock2Title'), body: t('mock2Body') },
    { num: '03', title: t('mock3Title'), body: t('mock3Body') },
  ];
  const profileRows = [
    { chapter: t('profileRow1'), a: { tag: t('tagDigest'), kind: s.tagDigest }, b: { tag: t('tagDeep'), kind: s.tagDeep } },
    { chapter: t('profileRow2'), a: { tag: t('tagRemove'), kind: s.tagRemove }, b: { tag: t('tagKeepAsIs'), kind: s.tagKeep } },
    { chapter: t('profileRow3'), a: { tag: t('tagDeep'), kind: s.tagDeep }, b: { tag: t('tagDigest'), kind: s.tagDigest } },
  ];
  const controlItems = [
    { icon: ListChecks, title: t('control1Title'), body: t('control1Body') },
    { icon: SlidersVertical, title: t('control2Title'), body: t('control2Body') },
    { icon: GitCompare, title: t('control3Title'), body: t('control3Body') },
    { icon: Clock, title: t('control4Title'), body: t('control4Body') },
  ];
  const steps = [
    { title: t('step1Title'), body: t('step1Body') },
    { title: t('step2Title'), body: t('step2Body') },
    { title: t('step3Title'), body: t('step3Body') },
    { title: t('step4Title'), body: t('step4Body') },
  ];
  const faq = [
    { q: t('faq1Q'), a: t('faq1A') },
    { q: t('faq2Q'), a: t('faq2A') },
    { q: t('faq3Q'), a: t('faq3A') },
    { q: t('faq4Q'), a: t('faq4A') },
    { q: t('faq5Q'), a: t('faq5A') },
    { q: t('faq6Q'), a: t('faq6A') },
  ];

  return (
    <div className={s.landingPage}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: seo('siteName'),
            applicationCategory: 'WebApplication',
            operatingSystem: 'Web',
            url: `${siteOrigin()}/${locale}`,
            description: seo('homeDescription'),
            inLanguage: locale,
            offers: { '@type': 'Offer', price: '1', priceCurrency: 'USD' },
          }).replace(/</g, '\\u003c'),
        }}
      />

      {/* ------------------------------------------------------------ Hero -- */}
      <section className={s.hero}>
        <div className={`${s.shell} ${s.heroGrid}`}>
          <div>
            <p className={s.eyebrow}>
              <Sparkles size={14} aria-hidden="true" />
              {t('eyebrow')}
            </p>
            <h1>
              {headline.map((part, index) => (
                <Fragment key={index}>
                  {index > 0 && <br />}
                  {part.trim()}
                </Fragment>
              ))}
            </h1>
            <p className={s.heroLead}>{t('lead')}</p>
            <div className={s.heroActions}>
              <Link href="/sign-up" className={`${s.btnHero} ${s.primary}`}>
                {t('ctaPrimary')}
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <a href="#features" className={s.btnHero}>
                {t('ctaSecondary')}
                <ArrowDown size={18} aria-hidden="true" />
              </a>
            </div>
            <ul className={s.heroProof}>
              <li><BookOpen size={16} aria-hidden="true" />{t('proof1')}</li>
              <li><ShieldCheck size={16} aria-hidden="true" />{t('proof2')}</li>
              <li><Download size={16} aria-hidden="true" />{t('proof3')}</li>
            </ul>
          </div>

          <div className={s.compareCard}>
            <div className={s.compareHead}>
              <span className={s.compareHeadTitle}>
                <Sparkles size={13} aria-hidden="true" />
                {t('compareHead')}
              </span>
              <span className={s.compareCount}>{t('compareCount')}</span>
            </div>
            <div className={s.compareBlock}>
              <p className={s.compareLabel}>{t('compareOriginal')}</p>
              <ul className={s.compareList}>
                {compareBefore.map((text, index) => {
                  const removed = index < 3;
                  return (
                    <li key={text} className={removed ? `${s.compareRow} ${s.compareRowRemoved}` : s.compareRow}>
                      <span className={s.compareText}>{text}</span>
                      {removed ? (
                        <span className={`${s.tag} ${s.tagRemove}`}>{t('tagRemove')}</span>
                      ) : (
                        <span className={`${s.tag} ${s.tagDeep}`}>
                          <ArrowRight size={11} aria-hidden="true" />
                          {t('tagDeep')}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className={s.compareDivider}>
              <span className={s.compareDividerLabel}>
                <ArrowDown size={12} aria-hidden="true" />
                {t('compareRebuilt')}
              </span>
            </div>
            <div className={s.compareBlock}>
              <p className={s.compareLabel}>{t('compareResult')}</p>
              <ul className={s.compareList}>
                {compareAfter.map((row) => (
                  <li key={row.num} className={s.compareRow}>
                    <span className={s.compareNum}>{row.num}</span>
                    <span className={s.compareText}>{row.text}</span>
                    <span className={`${s.tag} ${row.kind}`}>{row.tag}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className={s.compareFoot}>{t('compareFoot')}</p>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- 痛点条 -- */}
      <section className={s.pain}>
        <div className={s.shell}>
          <div className={s.painCard}>
            <h2>{t('painHead')}</h2>
            <p className={s.painBody}>{t('painBody')}</p>
            <p className={s.painStrong}>{t('painStrong')}</p>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- 三种处理 -- */}
      <section id="features" className={s.section}>
        <div className={s.shell}>
          <div className={s.sectionHead}>
            <h2>{t('treatHead')}</h2>
            <p>{t('treatSub')}</p>
          </div>
          <div className={s.treatGrid}>
            <article className={`${s.treatCard} ${s.treatWide}`}>
              <div>
                <span className={`${s.treatIcon} ${s.deep}`}>
                  <BookOpen size={20} aria-hidden="true" />
                </span>
                <h3>{t('treat1Title')}</h3>
                <p>{t('treat1Body')}</p>
              </div>
              <div className={s.sample}>
                <div className={s.sampleCol}>
                  <span className={s.sampleLabel}>{t('sampleBefore')}</span>
                  <p>{t('treat1SampleBefore')}</p>
                </div>
                <span className={s.sampleArrow} aria-hidden="true">
                  <ArrowRight size={16} />
                </span>
                <div className={`${s.sampleCol} ${s.after}`}>
                  <span className={s.sampleLabel}>{t('sampleAfter')}</span>
                  <p>{t('treat1SampleAfter')}</p>
                </div>
              </div>
            </article>

            <article className={s.treatCard}>
              <span className={`${s.treatIcon} ${s.digest}`}>
                <List size={20} aria-hidden="true" />
              </span>
              <h3>{t('treat2Title')}</h3>
              <p>{t('treat2Body')}</p>
              <div className={`${s.sampleStrip} ${s.digest}`}>
                <List size={15} aria-hidden="true" />
                {t('treat2Sample')}
              </div>
            </article>

            <article className={s.treatCard}>
              <span className={`${s.treatIcon} ${s.keep}`}>
                <Trash2 size={20} aria-hidden="true" />
              </span>
              <h3>{t('treat3Title')}</h3>
              <p>{t('treat3Body')}</p>
              <div className={`${s.sampleStrip} ${s.keep}`}>
                <Trash2 size={15} aria-hidden="true" />
                {t('treat3Sample')}
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- 成品样机 -- */}
      <section id="output" className={s.section}>
        <div className={`${s.shell} ${s.outputGrid}`}>
          <div className={s.outputCopy}>
            <div className={s.sectionHead}>
              <h2>{t('outputHead')}</h2>
              <p>{t('outputSub')}</p>
            </div>
            <ul className={s.outputPoints}>
              {outputPoints.map((point) => (
                <li key={point.title} className={s.outputPoint}>
                  <span className={s.outputIcon}>
                    <point.icon size={18} aria-hidden="true" />
                  </span>
                  <div>
                    <h3>{point.title}</h3>
                    <p>{point.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className={s.bookMock}>
            <div className={s.bookPage}>
              <p className={s.bookPageTitle}>{t('mockTitle')}</p>
              <ol className={s.bookToc}>
                {mockChapters.map((chapter) => (
                  <li key={chapter.num}>
                    <span className={s.bookNum}>{chapter.num}</span>
                    <div className={s.bookEntry}>
                      <p className={s.bookEntryTitle}>{chapter.title}</p>
                      <p className={s.bookEntryBody}>{chapter.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className={s.bookOrder}>{t('mockOrder')}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- 画像对照 -- */}
      <section id="profile" className={s.section}>
        <div className={s.shell}>
          <div className={s.sectionHead}>
            <h2>{t('profileHead')}</h2>
            <p>{t('profileSub')}</p>
          </div>
          <div className={s.profileTableWrap}>
            <table className={s.profileTable}>
              <thead>
                <tr>
                  <th scope="col">{t('profileColChapter')}</th>
                  <th scope="col">{t('profileColA')}</th>
                  <th scope="col">{t('profileColB')}</th>
                </tr>
              </thead>
              <tbody>
                {profileRows.map((row) => (
                  <tr key={row.chapter}>
                    <th scope="row" data-label={t('profileColChapter')}>{row.chapter}</th>
                    <td data-label={t('profileColA')}>
                      <span className={`${s.tag} ${row.a.kind}`}>{row.a.tag}</span>
                    </td>
                    <td data-label={t('profileColB')}>
                      <span className={`${s.tag} ${row.b.kind}`}>{row.b.tag}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={s.profileNote}>{t('profileNote')}</p>
        </div>
      </section>

      {/* -------------------------------------------------------------- 可控性 -- */}
      <section id="control" className={s.section}>
        <div className={s.shell}>
          <div className={s.sectionHead}>
            <h2>{t('controlHead')}</h2>
          </div>
          <div className={s.controlGrid}>
            {controlItems.map((item) => (
              <article key={item.title} className={s.controlItem}>
                <span className={s.controlIcon}>
                  <item.icon size={18} aria-hidden="true" />
                </span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ 四步上手 -- */}
      <section id="how" className={`${s.section} ${s.sectionAlt}`}>
        <div className={s.shell}>
          <div className={s.sectionHead}>
            <h2>{t('stepsHead')}</h2>
            <p>{t('stepsSub')}</p>
          </div>
          <ol className={s.steps}>
            {steps.map((step, index) => (
              <li key={step.title} className={s.step}>
                <span className={s.stepNum}>{String(index + 1).padStart(2, '0')}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------------------------------------------------------------- FAQ -- */}
      <section id="faq" className={s.section}>
        <div className={s.shell}>
          <div className={s.sectionHead}>
            <h2>{t('faqHead')}</h2>
            <p>{t('faqSub')}</p>
          </div>
          <div className={s.faq}>
            {faq.map((item) => (
              <details key={item.q}>
                <summary>
                  {item.q}
                  <ChevronDown className={s.faqChevron} size={18} aria-hidden="true" />
                </summary>
                <p className={s.faqA}>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ 收尾 CTA -- */}
      <section className={`${s.section} ${s.finalCta}`}>
        <div className={s.shell}>
          <div className={s.finalCtaCard}>
            <p className={s.finalCtaNote}>{t('priceNote')} {t('finalNote')}</p>
            <Link href="/sign-up" className={`${s.btnHero} ${s.primary}`}>
              {t('ctaPrimary')}
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- 页脚 -- */}
      <footer className={s.footer}>
        <div className={s.footerInner}>
          <div className={s.footerTop}>
            <Link href="/" className={s.footerBrand}>
              <BookOpen size={16} aria-hidden="true" />
              <span>{seo('siteName')}</span>
            </Link>
            <nav className={s.footerLinks} aria-label={t('footerNav')}>
              <a href="#features">{t('footerFeatures')}</a>
              <a href="#faq">{t('footerFaq')}</a>
              <Link href="/pricing">{t('footerPricing')}</Link>
              <Link href="/privacy">{t('footerPrivacy')}</Link>
              <Link href="/terms">{t('footerTerms')}</Link>
            </nav>
          </div>
          <div className={s.footerBottom}>
            © {new Date().getFullYear()} {seo('siteName')}
          </div>
        </div>
      </footer>

      <EmailCenterWidget locale={locale} />
    </div>
  );
}
