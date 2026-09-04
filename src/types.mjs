/**
 * Shared shapes for the room. JSDoc only — no runtime code, so importing this
 * module is free and it can never introduce a cycle.
 *
 * @typedef {'owner'|'member'|'viewer'} Role
 *
 * @typedef {Object} Member
 * @property {string} id
 * @property {string} name
 * @property {Role} role
 * @property {boolean} canApprove
 * @property {string} token
 * @property {string} [payerRef]  URL on the member's own machine that returns their credential
 *
 * @typedef {Object} Usage
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheCreate
 * @property {number} cache1h
 * @property {number} cache5m
 *
 * @typedef {Object} RoomMessage
 * @property {string} id
 * @property {string} memberId
 * @property {string} name
 * @property {string} text     display copy, leading mention stripped
 * @property {string} [content] verbatim copy, sent to the channel untouched
 * @property {number} ts
 * @property {boolean} addressed
 * @property {'chat'|'reply'|'activity'|'system'|'delegation'} kind
 * @property {{path:string,name:string}} [attachment]
 *
 * @typedef {Object} Participant
 * @property {string} memberId
 * @property {number} weight
 */

export {}
