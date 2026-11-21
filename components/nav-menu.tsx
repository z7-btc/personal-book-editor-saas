'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 顶部导航里的悬停菜单状态。
 *
 * 用户要的是「鼠标移到那儿就自动展开」。Radix 的菜单默认点开，所以这里
 * 在指针设备上接管 open：指针进入触发器或面板就展开，离开一小会儿再收，
 * 留出从按钮移进面板的时间；触屏设备上没有 hover，仍然保持点击展开。
 */
export function useHoverMenu() {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const canHover = useRef(false);

  useEffect(() => {
    canHover.current = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    return () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    };
  }, []);

  function cancelClose() {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  const hoverHandlers = {
    onPointerEnter: () => {
      if (!canHover.current) return;
      cancelClose();
      setOpen(true);
    },
    onPointerLeave: () => {
      if (!canHover.current) return;
      cancelClose();
      // 140ms 足够把指针从触发器挪进面板；再短会在两个元素之间闪一下。
      closeTimer.current = window.setTimeout(() => setOpen(false), 140);
    },
  };

  return { open, setOpen, hoverHandlers };
}
