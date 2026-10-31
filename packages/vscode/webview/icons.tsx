import type { SessionStatus, TaskStatus } from '@kvali/core/browser';

const base = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true } as const;

export function StatusIcon({ status }: { status: SessionStatus }) {
  switch (status) {
    case 'working':
      return (
        <svg {...base} class="icon spin">
          <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-opacity="0.25" stroke-width="2" />
          <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      );
    case 'waiting':
      return (
        <svg {...base} class="icon">
          <path d="M8 2.2a4 4 0 0 0-4 4v2.6L2.8 11h10.4L12 8.8V6.2a4 4 0 0 0-4-4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          <path d="M6.5 13a1.6 1.6 0 0 0 3 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      );
    case 'done':
      return (
        <svg {...base} class="icon">
          <path d="m3.5 8.4 2.9 2.8 6.1-6.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      );
    case 'error':
      return (
        <svg {...base} class="icon">
          <path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      );
    case 'stale':
      return (
        <svg {...base} class="icon">
          <circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2.2" />
        </svg>
      );
    default:
      return (
        <svg {...base} class="icon">
          <circle cx="8" cy="8" r="5.2" stroke="currentColor" stroke-width="1.5" />
        </svg>
      );
  }
}

export function TaskIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case 'completed':
      return (
        <svg {...base} class="icon">
          <circle cx="8" cy="8" r="6" fill="currentColor" fill-opacity="0.18" />
          <path d="m5.2 8.2 1.9 1.9 3.8-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      );
    case 'in_progress':
      return (
        <svg {...base} class="icon">
          <circle cx="8" cy="8" r="5.4" stroke="currentColor" stroke-width="1.5" />
          <path d="M8 2.6a5.4 5.4 0 0 1 0 10.8Z" fill="currentColor" />
        </svg>
      );
    case 'cancelled':
      return (
        <svg {...base} class="icon">
          <circle cx="8" cy="8" r="5.4" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.6" />
          <path d="M5.5 8h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      );
    case 'blocked':
      return (
        <svg {...base} class="icon">
          <circle cx="8" cy="8" r="5.4" stroke="currentColor" stroke-width="1.5" />
          <path d="M8 5v3.4M8 10.8v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...base} class="icon">
          <circle cx="8" cy="8" r="5.4" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.7" />
        </svg>
      );
  }
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg {...base} class={`icon chevron ${open ? 'open' : ''}`}>
      <path d="m6 4 4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function PhoneIcon() {
  return (
    <svg {...base} class="icon">
      <rect x="4.5" y="1.8" width="7" height="12.4" rx="1.6" stroke="currentColor" stroke-width="1.4" />
      <path d="M7 12h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}
