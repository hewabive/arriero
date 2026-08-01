import {
  Alert,
  Button,
  Group,
  PasswordInput,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";

import { loginAdmin } from "../../api/client";

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
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Login failed",
        message: (error as Error).message,
      });
    },
  });

  return (
    <Paper withBorder p="md" radius="sm">
      <form onSubmit={form.onSubmit((values) => loginMutation.mutate(values))}>
        <Stack gap="md">
          <div>
            <Title order={4}>Admin login</Title>
            <Text c="dimmed" size="sm">
              Admin access is required for process control, logs, build and
              configuration.
            </Text>
          </div>
          <Alert icon={<LockKeyhole size={16} />} color="blue">
            Public status remains available without signing in.
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
