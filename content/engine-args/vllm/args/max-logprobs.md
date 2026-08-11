---
schema: 1
engine: vllm
primaryName: "--max-logprobs"
title: "--max-logprobs"
summary: Серверный потолок на число logprobs, которое клиент может запросить на токен. Значение `-1` снимает потолок до размера словаря — это прямой путь к OOM и гигантским ответам.
group: ModelConfig
related:
  - --logprobs-mode
  - --max-model-len
  - --max-num-seqs
  - --skip-tokenizer-init
---

# --max-logprobs

## Кратко

`--max-logprobs` — не «сколько logprobs возвращать», а «сколько максимум разрешено попросить». Проверка выполняется на каждый запрос при разборе параметров сэмплинга и одинаково применяется к `logprobs` (выходные токены) и к `prompt_logprobs`.

Дефолт 20 взят из ограничения OpenAI Chat Completions API.

## Оригинальная справка

```text
Maximum number of log probabilities to return when `logprobs` is
specified in `SamplingParams`. The default value comes the default for the
OpenAI Chat Completions API. -1 means no cap, i.e. all (output_length *
vocab_size) logprobs are allowed to be returned and it may cause OOM.
```

## Паспорт аргумента

- Флаги: `--max-logprobs`
- Группа argparse: `ModelConfig`
- Тип значения: int
- Допустимые значения: `Field(default=20, ge=-1)` — минимум `-1`
- Значение по умолчанию: `20`
- Эффективное значение: не переопределяется движком. Draft-модель спекулятивного декодирования получает то же значение, что и целевая (`SpeculativeConfig`)
- Где объявлен: `vllm/config/model.py:ModelConfig.max_logprobs`
- Этап применения: HTTP-слой, валидация `SamplingParams` каждого запроса

## Что меняет в движке

`SamplingParams._validate_logprobs(model_config)` (`vllm/sampling_params.py`):

1. Берет `model_config.max_logprobs`; если это `-1`, подставляет размер словаря модели (`get_vocab_size()`).
2. Проверяет запрошенный `logprobs`: значение `-1` в запросе тоже раскрывается в размер словаря. Превышение — `Requested sample logprobs of N, which is greater than max allowed: M` с полем `parameter="logprobs"`.
3. Ту же проверку выполняет для `prompt_logprobs`: `Requested prompt logprobs of N, which is greater than max allowed: M`.

В OpenAI-совместимом chat-эндпоинте запрошенное число приходит из поля `top_logprobs` и уходит в `SamplingParams.logprobs`, если `logprobs: true`. Отдельно валидируется сам запрос: `top_logprobs` должен быть положительным или `-1`, и требует `logprobs: true`. При `echo: true` и незаданном `prompt_logprobs` в качестве последнего используется `top_logprobs` — то есть один и тот же потолок начинает применяться к промпту.

`--max-logprobs` не меняет, **что** именно возвращается в logprobs (сырые логиты, сырые логарифмы вероятностей или значения после логит-процессоров) — это задает `--logprobs-mode`.

## Значения и формат

- Целое ≥ 0 — потолок в штуках на токен. `0` фактически запрещает logprobs (любой положительный запрос превысит потолок).
- `20` — дефолт, совместимый с ограничением OpenAI API.
- `-1` — снять потолок: разрешено запросить все `output_length × vocab_size` значений. Справка прямо предупреждает, что это может вызвать OOM.
- Значения меньше `-1` отвергаются валидацией pydantic.

## Когда использовать

- Поднимать выше 20 — когда клиенту действительно нужен широкий срез распределения: калибровка, фильтрация, оценка неопределенности с фиксированным набором меток.
- Опускать до небольшого числа (или до `0`) — на сервере, доступном не только с localhost: logprobs это дешевый для клиента и дорогой для сервера способ вытянуть распределение модели и раздуть трафик.
- `-1` — только на изолированном стенде под конкретный эксперимент. На словаре порядка 150 тысяч токенов один ответ длиной 100 токенов означает 15 миллионов чисел в JSON.
- Не менять — если logprobs вообще не используются: дефолт уже консервативен.

## Влияние на производительность и память

- **VRAM.** Сам потолок память не резервирует; расход возникает на запросах, которые им пользуются, — logprobs собираются на устройстве и переносятся на хост.
- **RAM хоста и сеть.** Основная цена: объем сериализуемого ответа растет как «число токенов × запрошенное k».
- **Latency.** Заметная надбавка на больших `k` и особенно на `prompt_logprobs` для длинного промпта — там объем пропорционален длине промпта.
- **Throughput.** Косвенно: тяжелые ответы удерживают ресурсы фронтенда дольше, что чувствительно при большом `--max-num-seqs`.

## Взаимодействие с другими аргументами

- `--logprobs-mode`: определяет содержимое logprobs (сырые/обработанные логиты или логарифмы вероятностей); `--max-logprobs` — только их количество.
- `--max-model-len`: через длину промпта задает верхнюю границу объема `prompt_logprobs`.
- `--max-num-seqs`: сколько таких запросов может выполняться одновременно.
- `--skip-tokenizer-init`: logprobs остаются доступны, но возвращаются без текстовых представлений токенов.

## Типовые проблемы и диагностика

- **Симптом:** `Requested sample logprobs of 50, which is greater than max allowed: 20`. **Причина:** клиент запросил больше потолка. **Лечение:** уменьшить `top_logprobs` в запросе либо поднять аргумент.
- **Симптом:** `Requested prompt logprobs of N, which is greater than max allowed: M` на запросе, где `prompt_logprobs` не задавался. **Причина:** `echo: true` подставляет `top_logprobs` в `prompt_logprobs`. **Лечение:** задать `prompt_logprobs` явно или убрать `echo`.
- **Симптом:** `'top_logprobs' must be a positive value or -1.` или `when using 'top_logprobs', 'logprobs' must be set to true.` **Причина:** валидация тела запроса, а не серверного потолка. **Лечение:** исправить запрос.
- **Симптом:** OOM или обрыв соединения на запросе с logprobs. **Причина:** потолок снят (`-1`) или слишком велик для словаря модели. **Лечение:** вернуть конечное значение.

## Примеры

```bash
vllm serve /models/Qwen3-4B --max-logprobs 5 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --max-logprobs 100 --logprobs-mode processed_logprobs
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/sampling_params.py`
- `vllm/vllm/entrypoints/openai/chat_completion/protocol.py`
- `vllm/vllm/entrypoints/openai/chat_completion/serving.py`
- `vllm/vllm/config/speculative.py`
