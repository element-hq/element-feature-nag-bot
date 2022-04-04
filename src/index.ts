/*
Copyright 2019 New Vector Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { LogService, MatrixClient, RichConsoleLogger, SimpleFsStorageProvider } from "matrix-bot-sdk";
import * as path from "path";
import config from "./config";
import * as GithubGraphQLApi from "node-github-graphql";
import * as moment from "moment";
import { Moment } from "moment";

const DEFAULT_NOTIFICATION_DAYS = 28;
const MUTE_DAYS = 168; // 24 weeks

LogService.setLogger(new RichConsoleLogger());

const github = new GithubGraphQLApi({token: config.githubToken});

const storage = new SimpleFsStorageProvider(path.join(config.dataPath, "bot.json"));
const client = new MatrixClient(config.homeserverUrl, config.accessToken, storage);
let noticeRoomId = null;

let userId = null;
let displayName = null;
let localpart = null;

(async function () {
    noticeRoomId = await client.resolveRoom(config.noticeRoom);
    const joinedRooms = await client.getJoinedRooms();
    if (!joinedRooms.includes(noticeRoomId)) {
        noticeRoomId = await client.joinRoom(config.noticeRoom);
    }

    setInterval(onTick, 30 * 60 * 1000); // 30 min
    onTick(); // call immediately

    client.on("room.message", onMessage);

    userId = await client.getUserId();
    localpart = userId.split(':')[0].substring(1);

    const profile = await client.getUserProfile(userId);
    displayName = profile ? profile['displayname'] : null;

    client.start().then(() => LogService.info("index", "Bot started"));
})();

async function onTick() {
    const features = await getFeatureStates();
    for (const feature of features) {
        if (feature.nextPing.isAfter(moment())) continue;

        await client.sendText(noticeRoomId, `Hey team, ${feature.feature} was last modified ${feature.lastModified.fromNow()} by ${feature.author} - what's the plan? No response necessary. The next ping will be in ${DEFAULT_NOTIFICATION_DAYS} days or you can mute for longer with the \`!feature mute ${feature.feature} 30\` command.`);
        await setNextPingDays(feature.feature, DEFAULT_NOTIFICATION_DAYS);
    }
}

async function onMessage(roomId: string, event: any) {
    if (roomId !== noticeRoomId) return;
    if (!event['content']) return;

    const content = event['content'];
    if (content['msgtype'] === "m.text" && content['body']) {
        const prefixes = ["!feature", localpart + ":", displayName + ":", userId + ":"];
        const prefixUsed = prefixes.find(p => content['body'].startsWith(p));
        if (!prefixUsed) return;

        // rewrite the command for easier parsing
        event['content']['body'] = "!feature" + content['body'].substring(prefixUsed.length);

        await client.sendReadReceipt(roomId, event['event_id']);
        return handleCommand(roomId, event);
    }
}

async function handleCommand(roomId: string, event: any) {
    if (!config.authorizedUsers.includes(event['sender'])) {
        return client.sendNotice(roomId, `Sorry ${event['sender']}, you don't have permission to run this command`);
    }

    const args = event['content']['body'].split(' ');

    if (args.length > 0) {
        if (args[1] === 'mute' && args.length > 2) {
            let muteDays = MUTE_DAYS;
            if (args.length > 3 && Number(args[3])) muteDays = Number(args[3]);

            const feature = args[2];
            await setNextPingDays(feature, muteDays);

            const features = await getFeatureStates();
            const featureDef = features.find(f => f.feature === feature);
            if (!featureDef) {
                return client.sendNotice(roomId, "Feature not found");
            }

            return client.sendNotice(roomId, `${featureDef.feature} will cause a notification ${featureDef.nextPing.fromNow()}`);
        } else if (args[1] === 'status') {
            const features = await getFeatureStates();
            for (const feature of features) {
                const daysOld = feature.lastModified.fromNow();
                const daysMuted = feature.nextPing.fromNow();
                await client.sendNotice(roomId, `${feature.feature} was last touched by ${feature.author} ${daysOld} (next ping ${daysMuted})`);
            }

            if (!features.length) {
                await client.sendNotice(roomId, "No features");
            }

            return; // handled
        }
    }

    // else, show help
    const help = "Help:\n" +
        "!feature mute <feature name> [days] - Stop complaining about a feature for this amount of time\n" +
        "!feature status - Print current feature statuses\n";
    await client.sendNotice(roomId, help);
}

interface FeatureState {
    feature: string;
    author: string;
    lastModified: Moment;
    nextPing: Moment;
}

async function getFeatureStates(): Promise<FeatureState[]> {
    const blob = await getSettingsBlob();
    const blame = await getFeatureBlame();
    const results = mergeBlameLines(blame, blob);

    const features: FeatureState[] = [];
    for (const line of results) {
        const trimmed = line.line.trim();
        if (!trimmed.startsWith("\"feature_") || !trimmed.endsWith("\": {")) continue;

        const featureName = trimmed.substring(1, trimmed.length - 4);
        features.push({
            feature: featureName,
            author: line.author,
            lastModified: moment(line.date),
            nextPing: await getNextPingDate(featureName, moment(line.date)),
        });
    }

    return features;
}

async function getNextPingDate(featureName: string, addedDate: Moment): Promise<Moment> {
    let nextPing = moment(addedDate).add(DEFAULT_NOTIFICATION_DAYS, 'days');
    try {
        const pingInfo = await client.getAccountData(`im.vector.ping.${featureName}`);
        nextPing = moment(pingInfo['date']);
    } catch (e) {
        // ignore
    }

    return nextPing;
}

async function setNextPingDays(featureName: string, days: number) {
    await client.setAccountData(`im.vector.ping.${featureName}`, {date: moment().add(days, 'days').format()});
}

async function getFeatureBlame(): Promise<any> {
    return github.query(`{
        repository(name: "matrix-react-sdk", owner: "matrix-org") {
            ref(qualifiedName: "develop") {
                target {
                    ... on Commit {
                        blame(path: "src/settings/Settings.tsx") {
                            ranges {
                                commit {
                                    authoredDate
                                    author {
                                        user {
                                            login
                                        }
                                        name
                                    }
                                }
                                startingLine
                                endingLine
                            }
                        }
                    }
                }
            }
        }
    }`);
}

async function getSettingsBlob(): Promise<any> {
    return github.query(`{
        repository(name: "matrix-react-sdk", owner: "matrix-org") {
            object(expression: "develop:src/settings/Settings.tsx") {
                ... on Blob {
                    text
                }
            }
        }
    }`);
}

interface BlamedLine {
    line: string;
    author: string;
    date: string;
}

function mergeBlameLines(blame: any, blob: any): BlamedLine[] {
    const lines = blob['data']['repository']['object']['text'].replace(/\\r/g, '').split('\n');
    const ranges: [] = blame['data']['repository']['ref']['target']['blame']['ranges'];

    const compiledLines: BlamedLine[] = [];
    for (const line of lines) {
        const i = compiledLines.length + 1;
        const range = ranges.find(r => r['startingLine'] <= i && r['endingLine'] >= i);
        if (!range) continue; // wtf

        const author = range['commit']['author']['user'] ? range['commit']['author']['user']['login'] : range['commit']['author']['name'];
        const date = range['commit']['authoredDate'];
        compiledLines.push({line, author, date});
    }

    return compiledLines;
}
