import {DomainError,hash} from '../security.js';
import {get} from '../workspace.js';
/** Source-only recovery must not copy a live or unregistered business database as a file. */
export function recoverySourceBody(root:string,item:{path:string;bytes:number;sha256:string}):Buffer {
 const body=get(root,item.path);
 if(body.length!==item.bytes||hash(body)!==item.sha256)throw new DomainError('RECOVERY_SOURCE_CHANGED',409);
 const wal=body.length>=4&&[0x377f0682,0x377f0683].includes(body.readUInt32BE(0));
 if(/\.(?:sqlite|sqlite3|db)(?:-wal|-shm|-journal)?$|-(?:wal|shm|journal)$/i.test(item.path)||body.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))||wal||body.subarray(0,8).equals(Buffer.from([0xd9,0xd5,0x05,0xf9,0x20,0xa1,0x63,0xd7])))throw new DomainError('RECOVERY_DATABASE_UNREGISTERED',409);
 return body;
}
