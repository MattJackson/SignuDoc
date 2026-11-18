"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";

// An email field that suggests people from the organization's Google
// Workspace directory as the sender types a name or the start of an
// address (api/directory/people). Picking one fills in the address, and the
// name when that is still empty. Anyone outside the directory is typed in
// full as before; when the directory is not set up, this is a plain field.

type Person = { email: string; name: string };

type DirectoryEmailInputProps = {
  "aria-invalid"?: boolean;
  "aria-label": string;
  disabled?: boolean;
  maxLength?: number;
  onBlur?: () => void;
  onChange: (value: string) => void;
  onPick: (person: Person) => void;
  placeholder?: string;
  value: string;
};

const DEBOUNCE_MS = 200;
const MIN_TERM_LENGTH = 2;

export function DirectoryEmailInput({
  "aria-invalid": ariaInvalid,
  "aria-label": ariaLabel,
  disabled,
  maxLength,
  onBlur,
  onChange,
  onPick,
  placeholder,
  value,
}: DirectoryEmailInputProps) {
  const listId = useId();
  const [people, setPeople] = useState<Person[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  // Once the server says the directory is off, this field stops asking.
  const directoryOff = useRef(false);

  function close() {
    setOpen(false);
    setHighlighted(-1);
  }

  // Drops the queued lookup and any request still on its way, so a late
  // answer cannot reopen the list.
  function cancelPending() {
    if (timer.current) {
      clearTimeout(timer.current);
    }

    request.current?.abort();
    timer.current = null;
    request.current = null;
  }

  function search(term: string) {
    cancelPending();

    if (directoryOff.current || term.trim().length < MIN_TERM_LENGTH) {
      setPeople([]);
      close();
      return;
    }

    timer.current = setTimeout(() => {
      const controller = new AbortController();

      request.current = controller;
      fetch(`/api/directory/people?q=${encodeURIComponent(term.trim())}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as {
            enabled?: boolean;
            people?: Person[];
          } | null;

          // Superseded or cancelled while the body was read.
          if (controller.signal.aborted) {
            return;
          }

          if (payload?.enabled === false) {
            directoryOff.current = true;
          }

          const found = response.ok ? (payload?.people ?? []) : [];

          setPeople(found);
          setOpen(found.length > 0);
          setHighlighted(-1);
        })
        .catch(() => {
          // A cancelled or failed lookup leaves the field as it is.
        });
    }, DEBOUNCE_MS);
  }

  function pick(person: Person) {
    cancelPending();
    onPick(person);
    setPeople([]);
    close();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open || people.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((index) => (index + 1) % people.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((index) => (index <= 0 ? people.length - 1 : index - 1));
    } else if (event.key === "Enter" && highlighted >= 0) {
      event.preventDefault();
      pick(people[highlighted]!);
    } else if (event.key === "Escape") {
      close();
    }
  }

  return (
    <div className="relative">
      <input
        aria-activedescendant={
          open && highlighted >= 0 ? `${listId}-${highlighted}` : undefined
        }
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-invalid={ariaInvalid}
        aria-label={ariaLabel}
        autoComplete="off"
        className="field-input w-full"
        disabled={disabled}
        maxLength={maxLength}
        onBlur={() => {
          cancelPending();
          close();
          onBlur?.();
        }}
        onChange={(event) => {
          onChange(event.target.value);
          search(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        role="combobox"
        type="email"
        value={value}
      />
      {open ? (
        <ul
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-64 overflow-auto rounded-2xl border border-(--border) bg-white p-1 shadow-lg"
          id={listId}
          role="listbox"
        >
          {people.map((person, index) => (
            <li
              aria-selected={index === highlighted}
              className={`cursor-pointer rounded-xl px-3 py-2 text-sm ${
                index === highlighted
                  ? "bg-(--accent-softer)"
                  : "hover:bg-(--surface)"
              }`}
              id={`${listId}-${index}`}
              key={person.email}
              // Keeps the field focused, so its blur does not close the list
              // before the click lands.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(person);
              }}
              role="option"
            >
              <span className="block font-semibold text-(--fg)">
                {person.name || person.email}
              </span>
              {person.name ? (
                <span className="block text-xs text-(--secondary)">
                  {person.email}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
