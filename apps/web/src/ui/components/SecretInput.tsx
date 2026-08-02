import { ActionIcon, TextInput, type TextInputProps } from "@mantine/core";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

export function SecretInput(props: TextInputProps) {
  const [revealed, setRevealed] = useState(false);
  return (
    <TextInput
      {...props}
      autoComplete="off"
      spellCheck={false}
      rightSection={
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={revealed ? "Hide value" : "Reveal value"}
          onClick={() => setRevealed((value) => !value)}
        >
          {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
        </ActionIcon>
      }
      rightSectionPointerEvents="all"
      styles={{
        input: { WebkitTextSecurity: revealed ? "none" : "disc" },
      }}
    />
  );
}
