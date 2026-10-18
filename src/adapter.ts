/*
 * The debug adapter on its own, over stdin and stdout (the tests, other
 * editors): node out/src/adapter.js
 */
import { DebugSession } from '@vscode/debugadapter';
import { Esp32emuSession } from './session';

DebugSession.run(Esp32emuSession);
