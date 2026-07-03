import type { ArgumentDefault, ArgumentOption } from "@llama-manager/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  getLlamaArgumentDefaults,
  getLlamaArgumentDoc,
  getLlamaArgumentDocsSyncReport,
  getLlamaArgumentReference,
  updateLlamaArgumentDefaults,
} from "../../api/client";
import { displayEngineeringMarkdown } from "../components/EngineeringMarkdown";
import { argumentDefaultFromOption } from "../utils/argument-defaults";
import { readArgumentHelpRouteParams } from "../utils/argument-links";
import {
  allFilterValue,
  canUseAsInstanceDefault,
  defaultDraftKey,
  defaultUnavailableMessage,
  emptyArgumentDefaults,
  findInstanceDefault,
  findOptionByRouteArg,
  optionSearchText,
  upsertDefault,
  validateArgumentDefault,
} from "./arguments-view-helpers";

export function useArgumentsView() {
  const queryClient = useQueryClient();
  const isMobileList = useMediaQuery("(max-width: 48em)");
  const [routeParams, setRouteParams] = useState(() =>
    readArgumentHelpRouteParams(),
  );
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(allFilterValue);
  const [valueType, setValueType] = useState(allFilterValue);
  const [showDeprecated, setShowDeprecated] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [defaultValueDrafts, setDefaultValueDrafts] = useState<
    Record<string, string>
  >({});
  const [docsSyncEnabled, setDocsSyncEnabled] = useState(false);

  const argsCatalogQuery = useQuery({
    queryKey: ["llama-args-reference"],
    queryFn: getLlamaArgumentReference,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const argsCatalog = argsCatalogQuery.data?.data;
  const docsSyncQuery = useQuery({
    queryKey: ["llama-arg-docs-sync"],
    queryFn: () => getLlamaArgumentDocsSyncReport(),
    enabled: docsSyncEnabled,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const options = argsCatalog?.options ?? [];
  const categories = useMemo(
    () =>
      Array.from(new Set(options.map((option) => option.category)))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right)),
    [options],
  );
  const valueTypes = useMemo(
    () =>
      Array.from(new Set(options.map((option) => option.valueType))).sort(
        (left, right) => left.localeCompare(right),
      ),
    [options],
  );
  const filteredOptions = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const candidates = options.filter((option) => {
      if (!showDeprecated && option.deprecated) {
        return false;
      }
      if (category !== allFilterValue && option.category !== category) {
        return false;
      }
      if (valueType !== allFilterValue && option.valueType !== valueType) {
        return false;
      }
      return true;
    });
    if (!normalizedSearch) {
      return candidates;
    }
    const exactMatches = candidates.filter((option) =>
      [option.primaryName, ...option.names].some(
        (name) => name.toLowerCase() === normalizedSearch,
      ),
    );
    if (exactMatches.length > 0) {
      return exactMatches;
    }
    return candidates.filter((option) =>
      optionSearchText(option).includes(normalizedSearch),
    );
  }, [category, options, search, showDeprecated, valueType]);
  const selectedOption =
    options.find((option) => option.primaryName === selectedName) ?? null;
  const selectedDocQuery = useQuery({
    queryKey: ["llama-arg-doc", selectedOption?.primaryName],
    queryFn: () => getLlamaArgumentDoc(selectedOption!.primaryName),
    enabled: Boolean(selectedOption),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const selectedDoc = selectedDocQuery.data?.data;
  const argumentDefaultsQuery = useQuery({
    queryKey: ["llama-arg-defaults"],
    queryFn: getLlamaArgumentDefaults,
    staleTime: 60_000,
  });
  const argumentDefaults =
    argumentDefaultsQuery.data?.data ?? emptyArgumentDefaults;
  const selectedInstanceDefault = selectedOption
    ? findInstanceDefault(argumentDefaults, selectedOption)
    : null;

  useEffect(() => {
    const onHashChange = () => setRouteParams(readArgumentHelpRouteParams());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!argsCatalog || docsSyncEnabled) {
      return;
    }

    const timeout = window.setTimeout(() => setDocsSyncEnabled(true), 1_000);
    return () => window.clearTimeout(timeout);
  }, [argsCatalog, docsSyncEnabled]);

  useEffect(() => {
    const routeArg = routeParams.arg;
    if (!routeArg) {
      return;
    }

    setCategory(allFilterValue);
    setValueType(allFilterValue);

    const match = findOptionByRouteArg(options, routeArg);
    if (!match) {
      setSearch(routeArg);
      return;
    }

    if (match.deprecated) {
      setShowDeprecated(true);
    }
    setSearch(match.primaryName);
    setSelectedName(match.primaryName);
  }, [options, routeParams.arg]);

  useEffect(() => {
    if (filteredOptions.length === 0) {
      setSelectedName(null);
      return;
    }
    if (
      !selectedName ||
      !filteredOptions.some((option) => option.primaryName === selectedName)
    ) {
      setSelectedName(filteredOptions[0]?.primaryName ?? null);
    }
  }, [filteredOptions, selectedName]);

  useEffect(() => {
    if (!selectedOption) {
      return;
    }

    setDefaultValueDrafts((current) => {
      const suggested = argumentDefaultFromOption(selectedOption);
      const saved = findInstanceDefault(argumentDefaults, selectedOption);
      const key = defaultDraftKey(suggested.key);
      return {
        ...current,
        [key]: saved?.value ?? current[key] ?? suggested.value,
      };
    });
  }, [
    selectedOption?.primaryName,
    selectedInstanceDefault?.value,
    selectedInstanceDefault?.valueType,
  ]);

  const defaultsMutation = useMutation({
    mutationFn: updateLlamaArgumentDefaults,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["llama-arg-defaults"] });
      notifications.show({
        title: "Default arguments saved",
        message: selectedOption?.primaryName,
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Default arguments save failed",
        message: (error as Error).message,
      });
    },
  });

  function selectArgument(option: ArgumentOption) {
    setSelectedName(option.primaryName);
  }

  function copyArgumentName() {
    if (!selectedOption) {
      return;
    }
    navigator.clipboard
      .writeText(selectedOption.primaryName)
      .then(() =>
        notifications.show({
          title: "Argument copied",
          message: selectedOption.primaryName,
        }),
      )
      .catch((error: unknown) =>
        notifications.show({
          color: "red",
          title: "Copy failed",
          message: (error as Error).message,
        }),
      );
  }

  function saveInstanceDefault(
    enabled: boolean,
    patch?: Partial<ArgumentDefault>,
  ) {
    if (!selectedOption) {
      return;
    }
    if (!canUseAsInstanceDefault(selectedOption)) {
      notifications.show({
        color: "yellow",
        title: "Default argument is not applicable",
        message: "This option cannot be passed as a llama-server CLI argument.",
      });
      return;
    }
    const base = argumentDefaultFromOption(selectedOption);
    const current = findInstanceDefault(argumentDefaults, selectedOption);
    const nextDefault = { ...base, ...current, ...patch };
    const validationError = enabled
      ? validateArgumentDefault(nextDefault)
      : null;
    if (validationError) {
      notifications.show({
        color: "red",
        title: "Default argument is incomplete",
        message: validationError,
      });
      return;
    }

    const nextInstance = enabled
      ? upsertDefault(argumentDefaults.instance, nextDefault)
      : argumentDefaults.instance.filter((item) => item.key !== base.key);

    defaultsMutation.mutate({
      ...argumentDefaults,
      instance: nextInstance,
    });
  }

  const selectedDefaultUnavailableMessage = selectedOption
    ? defaultUnavailableMessage(selectedOption)
    : null;
  const visibleEngineeringMarkdown =
    selectedDoc && selectedDoc.exists && selectedOption
      ? displayEngineeringMarkdown({
          markdown: selectedDoc.markdown,
          primaryName: selectedOption.primaryName,
          title: selectedDoc.title,
        })
      : "";

  return {
    isMobileList,
    search,
    setSearch,
    category,
    setCategory,
    valueType,
    setValueType,
    showDeprecated,
    setShowDeprecated,
    defaultValueDrafts,
    setDefaultValueDrafts,
    argsCatalogQuery,
    argsCatalog,
    docsSyncQuery,
    options,
    categories,
    valueTypes,
    filteredOptions,
    selectedOption,
    selectedDocQuery,
    selectedDoc,
    argumentDefaults,
    selectedInstanceDefault,
    defaultsMutation,
    selectArgument,
    copyArgumentName,
    saveInstanceDefault,
    selectedDefaultUnavailableMessage,
    visibleEngineeringMarkdown,
  };
}

export type ArgumentsViewController = ReturnType<typeof useArgumentsView>;
