import Context from './context';

const platforms = {
	1: 'mobile',
	2: 'iphone',
	3: 'ipad',
	4: 'android',
	5: 'wphone',
	6: 'windows',
	7: 'standalone'
};

export default class UserOnlineContext extends Context {
	/**
	 * Constructor
	 *
	 * @param {VK}    vk
	 * @param {Array} update
	 */
	constructor(vk, [eventId, user, extra, date]) {
		super(vk);

		this.payload = {
			user_id: -user,
			extra,
			date
		};

		this.type = 'user_online';
		this.subTypes = [
			eventId === 8
				? 'online'
				: 'offline'
		];
	}

	/**
	 * Checks that the user is online
	 *
	 * @return {boolean}
	 */
	isUserOnline() {
		return this.subTypes.includes('online');
	}

	/**
	 * Checks that the user is online
	 *
	 * @return {boolean}
	 */
	isUserOffline() {
		return this.subTypes.includes('offline');
	}

	/**
	 * Checks that the user has logged out of the network himself
	 *
	 * @return {boolean}
	 */
	isSelfExit() {
		return this.isUserOffline() && !this.payload.extra;
	}

	/**
	 * Checks that the user logged out a timeout
	 *
	 * @return {boolean}
	 */
	isTimeoutExit() {
		return this.isUserOffline() && Boolean(this.payload.extra);
	}

	/**
	 * Returns the date when this event was created
	 *
	 * @return {number}
	 */
	getDate() {
		return this.payload.date;
	}

	/**
	 * Returns the name of the platform from which the user entered
	 *
	 * @return {?string}
	 */
	getPlatformName() {
		return platforms[this.payload.extra] || null;
	}
}