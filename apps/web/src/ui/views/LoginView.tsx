import {
  Alert,
  Button,
  Group,
  PasswordInput,
  Paper,
  Stack,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";

import { loginAdmin } from "../../api/client";
import { notifyError } from "../utils/notify";

export function LoginView() {
  const queryClient = useQueryClient();
  const form = useForm({
    initialValues: {
      password: "",
    },
  });
  const loginMutation = useMutation({
    mutationFn: loginAdmin,
    onSuccess: async () => {
      form.reset();
      await queryClient.invalidateQueries({ queryKey: ["auth-state"] });
      await queryClient.invalidateQueries({ queryKey: ["instances"] });
      await queryClient.invalidateQueries({
        queryKey: ["instances-health-summary"],
      });
    },
    onError: notifyError("Login failed"),
  });

  return (
    <Paper withBorder p="md" radius="sm">
      <form onSubmit={form.onSubmit((values) => loginMutation.mutate(values))}>
        <Stack gap="md">
          <Alert icon={<LockKeyhole size={16} />} color="blue">
            Sign in to control processes and read logs, builds and
            configuration. Public status stays available without signing in.
          </Alert>
          <PasswordInput
            label="Password"
            autoComplete="current-password"
            {...form.getInputProps("password")}
          />
          <Group justify="flex-end">
            <Button
              type="submit"
              leftSection={<LockKeyhole size={16} />}
              loading={loginMutation.isPending}
            >
              Sign in
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}
