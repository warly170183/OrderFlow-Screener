"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Primitives";

const DISMISSED_KEY = "oft-bug-report-dialog-dismissed";
const ISSUE_URL = "https://github.com/warly170183/OrderFlow-Screener/issues/new";
const X_URL = "https://x.com/intent/post?text=I%20found%20a%20bug%20in%20the%20Order%20Flow%20Terminal";

const DISMISS_EVENT = "oft-bug-report-dismissed";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(DISMISS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(DISMISS_EVENT, onChange);
  };
}

// The server snapshot reports "dismissed" so the dialog never renders during SSR.
const getSnapshot = () => window.localStorage.getItem(DISMISSED_KEY) !== "true";
const getServerSnapshot = () => false;

export default function BugReportDialog() {
  const open = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const dismiss = () => {
    window.localStorage.setItem(DISMISSED_KEY, "true");
    window.dispatchEvent(new Event(DISMISS_EVENT));
  };

  if (!open) return null;

  return (
    <div className="bug-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) dismiss();
    }}>
      <section className="bug-dialog" role="dialog" aria-modal="true" aria-labelledby="bug-dialog-title">
        <div className="bug-dialog-icon">!</div>
        <div className="bug-dialog-copy">
          <div className="ui-eyebrow">Help improve the terminal</div>
          <h2 id="bug-dialog-title">Want to report a bug?</h2>
          <p>Tell us what went wrong so we can make the market data experience better.</p>
          <div className="bug-dialog-actions">
            <a className="ui-button is-active" href={ISSUE_URL} target="_blank" rel="noreferrer" onClick={dismiss}>
              Raise an issue
            </a>
            <a className="ui-button" href={X_URL} target="_blank" rel="noreferrer" onClick={dismiss}>
              Send a DM on X
            </a>
          </div>
          <Button className="bug-dialog-later" onClick={dismiss}>Maybe later</Button>
        </div>
      </section>
    </div>
  );
}
