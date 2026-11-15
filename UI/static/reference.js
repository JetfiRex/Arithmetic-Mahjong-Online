"use strict";

// Static reference content: no game state, requests, timers or redraw hooks.
(() => {
  const toggle = document.getElementById("reference-toggle");
  const sidebar = document.getElementById("reference-sidebar");
  const close = document.getElementById("reference-close");
  const tabs = [...sidebar.querySelectorAll('[role="tab"]')];
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute("aria-controls")));
  let selected = 0;

  function select(index, focus = false) {
    selected = index;
    tabs.forEach((tab, position) => {
      const active = position === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[position].hidden = !active;
    });
    if (focus) tabs[selected].focus();
  }

  function setOpen(open) {
    sidebar.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("reference-open", open);
    if (open) tabs[selected].focus();
    else toggle.focus();
  }

  toggle.onclick = () => setOpen(sidebar.hidden);
  close.onclick = () => setOpen(false);
  tabs.forEach((tab, index) => {
    tab.onclick = () => select(index);
    tab.onkeydown = event => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(next, true);
    };
  });
  sidebar.onkeydown = event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };
})();
