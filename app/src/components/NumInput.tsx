"use client";

import { type InputHTMLAttributes, useEffect, useState } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: number;
  onValue: (n: number) => void;
};

/**
 * A number field that keeps what you type while you edit: clearing it leaves it empty (not "0"), so
 * typing "500" reads "500". The number goes out as you type; an empty or invalid field counts as 0.
 */
export function NumInput({ value, onValue, onFocus, onBlur, ...rest }: Props) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  return (
    <input
      {...rest}
      type="number"
      value={text}
      onFocus={(e) => {
        setEditing(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setEditing(false);
        setText(String(value));
        onBlur?.(e);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        onValue(e.target.value.trim() === "" || !Number.isFinite(n) ? 0 : Math.max(0, n));
      }}
    />
  );
}
