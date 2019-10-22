# riot-feature-nag-bot
A Matrix bot that complains when riot-web features take too long

## Docker (preferred)

Build with `docker build -t feature-nag-bot .`.

```bash
git clone https://github.com/vector-im/riot-feature-nag-bot.git
cd riot-feature-nag-bot

# Build it
docker build -t feature-nag-bot .

# Copy and edit the config. It is not recommended to change the data path.
mkdir -p /etc/feature-nag-bot
cp config/default.yaml /etc/feature-nag-bot/production.yaml
nano /etc/feature-nag-bot/production.yaml

# Run it
docker run --rm -it -v /etc/feature-nag-bot:/data feature-nag-bot:latest
```

## Build it

This bot requires `yarn` and Node 10.

```bash
git clone https://github.com/vector-im/riot-feature-nag-bot.git
cd mjolnir

yarn install
yarn build

# Copy and edit the config. It *is* recommended to change the data path.
cp config/default.yaml config/development.yaml
nano config/development.yaml

node lib/index.js
```

## Development

TODO. It's a TypeScript project with a linter.

## User help

It complains every so often, with some commands to make it work:

![](https://i.imgur.com/zzNu5HA.png)
