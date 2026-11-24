import { greenhouse } from './greenhouse/project';
import { rover } from './rover/project';
import { rp2350Devboard } from './rp2350-devboard/project';
import { tidepool } from './tidepool/project';

export { DEFAULT_THREAD_ID } from './rp2350-devboard/threads';

export const projects = [rp2350Devboard, greenhouse, tidepool, rover];
