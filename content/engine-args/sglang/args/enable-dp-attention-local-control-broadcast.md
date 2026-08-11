---
schema: 1
engine: sglang
primaryName: "--enable-dp-attention-local-control-broadcast"
title: "--enable-dp-attention-local-control-broadcast"
summary: Меняет способ рассылки управляющих сообщений при DP-attention — контроллер шлет каждому лидеру DP-группы, и тот транслирует внутри своей attn_tp_group вместо полной tp_group. Убирает один gloo-коллектив на итерацию планировщика.
group: parallel
related:
  - --enable-dp-attention
  - --dp-size
  - --tp-size
  - --enable-dp-lm-head
  - --elastic-ep-backend
  - --max-ep-size
  - --dwdp-size
---

# --enable-dp-attention-local-control-broadcast

## Кратко

Флаг влияет ровно на одну вещь — на топологию рассылки управляющих сообщений от `DataParallelController` к scheduler-процессам при включенном DP-attention. По умолчанию сообщение уходит только первому лидеру, который затем транслирует его по **всей** TP-группе; с флагом сообщение уходит каждому лидеру DP-группы, и трансляция идет внутри `attn_tp_group`. Оригинальная справка описывает выигрыш как устранение дорогого gloo-синка по всем рангам на каждой итерации планировщика. Значение по умолчанию `false`, но в двух режимах движок включает его сам.

## Оригинальная справка

```text
With DP-attention, send control messages to every DP group leader and broadcast within attn_tp_group instead of the full tp_group. Eliminates a costly all-ranks gloo sync on every scheduler iteration.
```

## Паспорт аргумента

- Флаги: `--enable-dp-attention-local-control-broadcast`
- Группа: `parallel`
- Тип значения: bool (флаг без значения)
- Допустимые значения: присутствует / отсутствует; парного `--no-…` нет
- Значение по умолчанию: `false`
- Эффективное значение: принудительно `True` при `--dwdp-size > 1` (`_handle_dwdp`) и при активном elastic EP scale-up (`_handle_elastic_ep`, ветка `scaling_active`). В остальном действует заданное значение
- Где объявлен: `ServerArgs.enable_dp_attention_local_control_broadcast`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, оптимизационный
- Этап применения: `__post_init__` (принудительные включения) → конструктор `DataParallelController` (выбор `control_message_step`) → каждая рассылка управляющего сообщения в течение работы

## Что меняет в движке

Единственное место применения — `managers/data_parallel_controller.py`:

```python
local_ctrl = server_args.enable_dp_attention_local_control_broadcast
self.control_message_step = 1 if local_ctrl else server_args.tp_size
```

и рассылка

```python
def send_control_message(self, obj):
    for i in self._active_workers[:: self.control_message_step]:
        ...
```

То есть при выключенном флаге контроллер шлет сообщение каждому `tp_size`-му активному воркеру — практически только первому, — и дальше оно расходится broadcast'ом по полной `tp_group`. При включенном флаге шаг равен `1`: сообщение получает каждый воркер-лидер DP-группы, а трансляция идет внутри `attn_tp_group`, которая в `dp_size == tp_size` вырождается в один ранг.

`send_control_message` — это fallback-ветка диспетчера сообщений контроллера: через нее идут все типы, для которых нет специального обработчика (генерация и эмбеддинги маршрутизируются балансировщиком, `BlockReqInput`/`ProfileReq` уходят всем воркерам явным `send_to_all_workers`).

Ветка `control_message_step = 1` действует и без DP-attention: в `launch_dp_schedulers` (native DP) шаг всегда `1`. Флаг имеет смысл только на пути `launch_dp_attention_schedulers`.

## Значения и формат

- Флаг без аргумента. «Не задан» = рассылка первому лидеру плюс broadcast по полной `tp_group`.
- Вне `--enable-dp-attention` не делает ничего: ветка, читающая флаг, находится под `if server_args.enable_dp_attention`.
- Отдельного «частичного» режима нет: либо шаг `1`, либо шаг `tp_size`.

## Когда использовать

- Большие DP-attention-развертывания (`tp_size` 8 и выше), где на каждой итерации планировщика виден лишний коллектив по всем рангам: это ровно та проблема, ради которой флаг введен.
- Обязателен при elastic EP scale-up — движок включает его сам, задавать вручную не нужно.
- Не включайте без `--enable-dp-attention`: эффекта не будет.
- Не рассматривайте как ручку throughput: он снимает накладные расходы управляющего пути, а не считает токены.

## Влияние на производительность и память

- **Latency.** Основной эффект — убирается gloo-синхронизация по всем рангам на каждой итерации планировщика. Заметнее всего при большом world size и коротких decode-шагах.
- **VRAM.** Не влияет.
- **RAM хоста.** Незначительно: контроллер шлет `dp_size` сообщений вместо одного, но сообщения управляющие и мелкие.
- **Throughput.** Косвенно, через снятую задержку в общем цикле.
- **Время старта.** Не меняет.

## Взаимодействие с другими аргументами

- `--enable-dp-attention`: без него флаг мертв.
- `--dp-size` / `--tp-size`: определяют шаг `tp_size` в выключенном состоянии и размер `attn_tp_group` во включенном.
- `--dwdp-size`: включает флаг автоматически (вместе с `--enable-dp-attention` и `--enable-dp-lm-head`).
- `--elastic-ep-backend` + `--max-ep-size` в режиме scale-up: включает флаг автоматически.
- `--enable-dp-lm-head`: независим, но в тех же конфигурациях включается вместе.

## Типовые проблемы и диагностика

- Флаг задан, эффекта нет — почти всегда потому, что DP-attention не активировался (`--dp-size` равен 1). Проверьте наличие строки `DP attention is enabled. chunked prefill size is adjusted from … to …` в логе.
- Собственных сообщений об ошибках у аргумента нет: он ничего не валидирует и ничего не запрещает.
- Единственное подтверждение принятого значения — дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`); в конфигурациях DWDP включение видно в строке `DWDP enabled: … dp_attention_local_control_broadcast=True …`.
- Если под нагрузкой видны длинные паузы в цикле планировщика при большом world size, а флаг выключен, это разумная первая гипотеза — но проверять ее нужно профилем, а не логом: отдельной метрики у этого коллектива нет.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --enable-dp-attention-local-control-broadcast --ep-size 8 --moe-a2a-backend deepep
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --tensor-parallel-size 4 --dp-size 4 --enable-dp-attention --enable-dp-attention-local-control-broadcast --enable-dp-lm-head
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/managers/scheduler_components/dp_attn.py`
- `sglang/python/sglang/srt/layers/dp_attention.py`
