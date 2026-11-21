'use client';

import { useEffect, useRef, useState } from 'react';

/** 悬停后稍等一下再展开：鼠标只是扫过顶栏时，菜单不应该弹出来。 */
const OPEN_DELAY_MS = 90;
/** 指针离开后留出的时间，够从按钮挪进面板；再短会在按钮和面板之间闪一下。 */
const CLOSE_DELAY_MS = 300;

/**
 * 顶部导航里的悬停菜单状态。
 *
 * 用户要的是「鼠标移到那儿就自动展开」。Radix 的菜单默认点开，所以这里
 * 在指针设备上接管 open：指针进入触发器或面板就展开，离开一小会儿再收，
 * 留出从按钮移进面板的时间；触屏设备上没有 hover，仍然保持点击展开。
 *
 * 两点必须一起处理，否则菜单会「弹个不停」：
 *  - 收起是用户自己按的（Esc、选了菜单项、点了别处）时，指针还停在按钮上，
 *    这时任何一点鼠标移动都会重新触发悬停展开；先按住，等指针移开按钮再恢复。
 *  - 菜单用非模态（modal={false}）打开，避免打开期间整页 pointer-events 被关掉，
 *    否则点击按钮关不掉，关掉之后光标一动又立刻弹回来。
 */
export function useHoverMenu() {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const canHover = useRef(false);
  /**
   * 用户主动收起后，指针还停在触发按钮或面板上时不再自动展开；
   * 指针离开一次就恢复悬停展开。
   */
  const stayClosed = useRef(false);

  useEffect(() => {
    canHover.current = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    return () => {
      if (openTimer.current) window.clearTimeout(openTimer.current);
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    };
  }, []);

  function cancelOpen() {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }

  function cancelClose() {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  /** 接 Radix 的 onOpenChange：用户主动关掉时记一笔，别让悬停立刻又把它拉起来。 */
  function onOpenChange(next: boolean) {
    cancelOpen();
    if (next) {
      stayClosed.current = false;
      setOpen(true);
      return;
    }
    stayClosed.current = true;
    setOpen(false);
  }

  const hoverHandlers = {
    onPointerEnter: () => {
      if (!canHover.current) return;
      cancelClose();
      cancelOpen();
      if (open || stayClosed.current) return;
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null;
        setOpen(true);
      }, OPEN_DELAY_MS);
    },
    onPointerLeave: () => {
      if (!canHover.current) return;
      cancelOpen();
      cancelClose();
      // 指针移开了，下次移回来可以重新悬停展开。
      stayClosed.current = false;
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setOpen(false);
      }, CLOSE_DELAY_MS);
    },
  };

  return { open, onOpenChange, close: () => onOpenChange(false), hoverHandlers };
}
