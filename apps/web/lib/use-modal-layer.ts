"use client";

import { useEffect, useLayoutEffect } from "react";

interface ScrollSnapshot {
  scrollX: number;
  scrollY: number;
  htmlOverflow: string;
  htmlOverscrollBehavior: string;
  bodyPosition: string;
  bodyTop: string;
  bodyLeft: string;
  bodyRight: string;
  bodyWidth: string;
  bodyOverflow: string;
  bodyPaddingRight: string;
}

let modalLayerCount = 0;
let snapshot: ScrollSnapshot | null = null;
const useClientLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function acquireDocumentScrollLock() {
  modalLayerCount += 1;
  if (modalLayerCount > 1) return;

  const html = document.documentElement;
  const body = document.body;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  snapshot = {
    scrollX,
    scrollY,
    htmlOverflow: html.style.overflow,
    htmlOverscrollBehavior: html.style.overscrollBehavior,
    bodyPosition: body.style.position,
    bodyTop: body.style.top,
    bodyLeft: body.style.left,
    bodyRight: body.style.right,
    bodyWidth: body.style.width,
    bodyOverflow: body.style.overflow,
    bodyPaddingRight: body.style.paddingRight,
  };

  const scrollbarWidth = Math.max(0, window.innerWidth - html.clientWidth);
  const bodyPaddingRight =
    Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;

  html.style.overflow = "hidden";
  html.style.overscrollBehavior = "none";
  body.style.position = "fixed";
  body.style.top = `${-scrollY}px`;
  body.style.left = `${-scrollX}px`;
  body.style.right = "0";
  body.style.width = "100%";
  body.style.overflow = "hidden";
  if (scrollbarWidth > 0) {
    body.style.paddingRight = `${bodyPaddingRight + scrollbarWidth}px`;
  }
}

function releaseDocumentScrollLock() {
  modalLayerCount = Math.max(0, modalLayerCount - 1);
  if (modalLayerCount > 0 || !snapshot) return;

  const html = document.documentElement;
  const body = document.body;
  const saved = snapshot;
  snapshot = null;

  html.style.overflow = saved.htmlOverflow;
  html.style.overscrollBehavior = saved.htmlOverscrollBehavior;
  body.style.position = saved.bodyPosition;
  body.style.top = saved.bodyTop;
  body.style.left = saved.bodyLeft;
  body.style.right = saved.bodyRight;
  body.style.width = saved.bodyWidth;
  body.style.overflow = saved.bodyOverflow;
  body.style.paddingRight = saved.bodyPaddingRight;
  window.scrollTo(saved.scrollX, saved.scrollY);
}

/** Locks the document behind one or more stacked modal layers. */
export function useModalLayer(active = true) {
  useClientLayoutEffect(() => {
    if (!active) return;
    acquireDocumentScrollLock();
    return releaseDocumentScrollLock;
  }, [active]);
}
