import {
  ActionIcon,
  Autocomplete,
  type AutocompleteProps,
  type ComboboxItem,
  type OptionsFilter,
  Select,
  type SelectProps,
} from "@mantine/core";
import { useMediaQuery, useMergedRef } from "@mantine/hooks";
import { Keyboard } from "lucide-react";
import { type ForwardedRef, forwardRef, useRef, useState } from "react";

export const substringOptionsFilter: OptionsFilter = ({
  options,
  search,
  limit,
}) => {
  const flat = options.filter((item): item is ComboboxItem => "value" in item);
  const query = search.trim().toLowerCase();
  const showAll =
    !query || flat.some((item) => item.value.toLowerCase() === query);
  const matched = showAll
    ? flat
    : flat.filter((item) => item.value.toLowerCase().includes(query));
  return matched.slice(0, limit);
};

function useTouchListFirst(
  ref: ForwardedRef<HTMLInputElement>,
  hasLeftSection: boolean,
) {
  const coarsePointer = useMediaQuery("(pointer: coarse)", false, {
    getInitialValueInEffect: false,
  });
  const innerRef = useRef<HTMLInputElement>(null);
  const mergedRef = useMergedRef(ref, innerRef);
  const [typing, setTyping] = useState(false);

  const enableTyping = () => {
    setTyping(true);
    requestAnimationFrame(() => innerRef.current?.focus());
  };

  const toggle = hasLeftSection ? null : (
    <ActionIcon
      aria-label="Type manually"
      color="gray"
      size="sm"
      variant="subtle"
      onMouseDown={(event) => event.preventDefault()}
      onClick={enableTyping}
    >
      <Keyboard size={16} />
    </ActionIcon>
  );

  const leftSectionProps = toggle
    ? { leftSection: toggle, leftSectionPointerEvents: "all" as const }
    : {};

  return {
    coarsePointer,
    mergedRef,
    typing,
    setTyping,
    leftSectionProps,
  };
}

export const TouchAutocomplete = forwardRef<
  HTMLInputElement,
  AutocompleteProps
>(function TouchAutocomplete(props, ref) {
  const { coarsePointer, mergedRef, typing, setTyping, leftSectionProps } =
    useTouchListFirst(ref, Boolean(props.leftSection));

  if (!coarsePointer) {
    return <Autocomplete ref={ref} {...props} />;
  }

  return (
    <Autocomplete
      {...props}
      {...leftSectionProps}
      ref={mergedRef}
      inputMode={typing ? "text" : "none"}
      onOptionSubmit={(value) => {
        setTyping(false);
        props.onOptionSubmit?.(value);
      }}
      onBlur={(event) => {
        setTyping(false);
        props.onBlur?.(event);
      }}
    />
  );
});

export const TouchSelect = forwardRef<HTMLInputElement, SelectProps>(
  function TouchSelect(props, ref) {
    const { coarsePointer, mergedRef, typing, setTyping, leftSectionProps } =
      useTouchListFirst(ref, Boolean(props.leftSection));

    if (!coarsePointer || !props.searchable) {
      return <Select ref={ref} {...props} />;
    }

    return (
      <Select
        {...props}
        {...leftSectionProps}
        ref={mergedRef}
        inputMode={typing ? "text" : "none"}
        onChange={(value, option) => {
          setTyping(false);
          props.onChange?.(value, option);
        }}
        onBlur={(event) => {
          setTyping(false);
          props.onBlur?.(event);
        }}
      />
    );
  },
);
