import SiteHeader from '@/components/site-header';

/**
 * 站点外框：顶栏 + 页面内容。
 *
 * 顶栏单独拆成 `SiteHeader`，因为它是全站唯一同时要处理登录态、悬停菜单
 * 和窄屏汉堡菜单的地方；这个布局只负责留出位置。
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      {children}
    </div>
  );
}
