---
schema: 1
engine: sglang
primaryName: "--gated-launch-port"
title: "--gated-launch-port"
summary: "Приостанавливает старт после инициализации distributed до HTTP-команды активации. Позволяет отложить крупные GPU-аллокации."
group: parallel
related:
  - --host
  - --port
  - --dist-init-addr
---

# --gated-launch-port

## Кратко

Приостанавливает старт после инициализации distributed до HTTP-команды активации. Позволяет отложить крупные GPU-аллокации.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
The port of the gated launch control server. When set, every rank blocks right after the distributed environment is initialized, before any sizable GPU allocation, until `POST /gate/activate` is sent to this port on the host of the first rank. This lets an external orchestrator defer the memory hungry part of startup to a safe window. Defaults to None, which disables the gate.
```

## Паспорт аргумента

- Флаг: `--gated-launch-port`
- Группа: `parallel`
- Тип: `int`
- Декларативный default: `null`
- Объявление: `ServerArgs.gated_launch_port` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

После distributed bootstrap каждый rank ждёт сигнал. Первый rank поднимает отдельный HTTP-сервер на `--host` и этом порту; `POST /gate/activate` выставляет флаг, который рассылается через CPU process group. `GET /health` возвращает OK именно для control server, а не готовность модели.

## Значения и формат

Целый свободный TCP-порт. `None` при отсутствии аргумента выключает gate. HTTP API управления не содержит проверки API key.

## Когда использовать

Когда внешний оркестратор должен освободить память перед загрузкой модели. Без клиента, отправляющего активацию, запуск останется в ожидании.

## Влияние на производительность и память

Откладывает память-вместительную часть старта, но не отменяет начальную инициализацию CUDA/distributed и не снижает итоговую память модели. Сигнал опрашивается примерно раз в секунду.

## Взаимодействие с другими аргументами

`--host` определяет bind control server. Порт должен отличаться от HTTP-порта модели и distributed портов. На доступном извне host любой достигающий control port клиент может активировать запуск.

## Типовые проблемы и диагностика

Логи `Gated launch waiting for activation`, `still waiting for activation` и `Gated launch activated` различают ожидание и продолжение. При бесконечном ожидании проверьте доступность порта первого rank.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --host 127.0.0.1 --gated-launch-port 30001
```

После появления control server: `curl -X POST http://127.0.0.1:30001/gate/activate`.

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/distributed/gated_launch.py`
