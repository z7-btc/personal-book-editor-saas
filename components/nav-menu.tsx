'use client';

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** 悬停后稍等一下再展开：鼠标只是扫过顶栏时，菜单不应该弹出来。 */
const OPEN_DELAY_MS = 90;
/** 指针离开后留出的时间，够从按钮挪进面板（4px 空隙慢一点也来得及）。 */
const CLOSE_DELAY_MS = 400;

/**
 * 顶部导航里的悬停菜单状态。
 *
 * 用户要的是「鼠标移到那儿就自动展开」。Radix 的菜单默认点开，所以这里
 * 在指针设备上接管 open：指针进入触发器或面板就展开，离开一小会儿再收，
 * 留出从按钮移进面板的时间；触屏设备上没有 hover，仍然保持点击展开。
 *
 * 两点必须一起处理，否则菜单会「弹个不停」：
 *  - 收起是用户自己按的（Esc、选了菜单项、点了别处）时，指针可能还停在
 *    按钮或面板上，这时任何一点鼠标移动都会重新触发悬停展开；先按住，
 *    等指针真的离开这些元素再恢复。
 *  - 菜单用非模态（modal={false}）打开，避免打开期间整页 pointer-events 被关掉，
 *    否则点击按钮关不掉，关掉之后光标一动又立刻弹回来。
 *
 * 「按住」只针对收起那一刻指针所在的那些元素：选主题、点面板里的项、点
 * 页面别处收起时，指针本来就不在按钮上，再要求「移开一次」会把下一次正常
 * 的悬停吞掉。所以按住期间一旦指针落到别的元素（包括从面板挪回按钮），
 * 就当场恢复悬停展开，不用等下一次进出。
 */
export function useHoverMenu() {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const canHover = useRef(false);
  /** 用户主动收起后，指针还停在收起时那些元素上时不自动展开。 */
  const stayClosed = useRef(false);
  /** 收起那一刻指针所在的元素；指针落到别的元素上就说明这是一次新的靠近。 */
  const closedTargets = useRef<Set<Element>>(new Set());
  /** 指针当前停留的触发器/面板元素，用来判断指针到底离开了没有。 */
  const hoverTargets = useRef<Set<Element>>(new Set());
  const leaveWatch = useRef<((event: PointerEvent) => void) | null>(null);

  useEffect(() => {
    canHover.current = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    return () => {
      if (openTimer.current) window.clearTimeout(openTimer.current);
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
      if (leaveWatch.current) {
        document.removeEventListener('pointermove', leaveWatch.current);
        leaveWatch.current = null;
      }
    };
  }, []);

  function applyOpen(next: boolean) {
    openRef.current = next;
    setOpen(next);
  }

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

  function stopLeaveWatch() {
    if (leaveWatch.current) {
      document.removeEventListener('pointermove', leaveWatch.current);
      leaveWatch.current = null;
    }
  }

  function resumeHover() {
    stayClosed.current = false;
    stopLeaveWatch();
  }

  /** 指针在触发器上停够 OPEN_DELAY_MS 再展开。 */
  function scheduleOpen() {
    if (openRef.current || stayClosed.current) return;
    cancelOpen();
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      applyOpen(true);
    }, OPEN_DELAY_MS);
  }

  /**
   * 主动收起后按住悬停展开：指针还在收起时那些元素里就不弹回来，
   * 一旦移动到它们之外就立刻恢复正常悬停（如果正好落在触发器上，
   * 这次移动本身就是一次新的靠近，补上展开）。
   */
  function holdHoverClosed() {
    stayClosed.current = true;
    closedTargets.current = new Set(hoverTargets.current);
    stopLeaveWatch();
    const onMove = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      for (const element of closedTargets.current) {
        if (!element.isConnected) {
          closedTargets.current.delete(element);
          continue;
        }
        if (target && element.contains(target)) return;
      }
      resumeHover();
      for (const element of hoverTargets.current) {
        if (!element.isConnected) continue;
        if (target && element.contains(target)) {
          scheduleOpen();
          return;
        }
      }
    };
    leaveWatch.current = onMove;
    document.addEventListener('pointermove', onMove, { passive: true });
  }

  /** 接 Radix 的 onOpenChange：用户主动关掉时记一笔，别让悬停立刻又把它拉起来。 */
  function onOpenChange(next: boolean) {
    cancelOpen();
    if (next) {
      resumeHover();
      applyOpen(true);
      return;
    }
    holdHoverClosed();
    applyOpen(false);
  }

  const hoverHandlers = {
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
      if (!canHover.current) return;
      const element = event.currentTarget;
      hoverTargets.current.add(element);
      cancelClose();
      // 落在收起时以外的元素上：指针已经离开又回来，照常允许悬停展开。
      if (stayClosed.current && !closedTargets.current.has(element)) resumeHover();
      scheduleOpen();
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      if (!canHover.current) return;
      hoverTargets.current.delete(event.currentTarget);
      cancelOpen();
      cancelClose();
      // 指针移开了，下次移回来可以重新悬停展开。
      resumeHover();
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        applyOpen(false);
      }, CLOSE_DELAY_MS);
    },
  };

  return { open, onOpenChange, close: () => onOpenChange(false), hoverHandlers };
}
