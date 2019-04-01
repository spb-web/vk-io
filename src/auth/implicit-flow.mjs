import cheerio from 'cheerio';
import createDebug from 'debug';

import nodeUrl from 'url';
import nodeUtil from 'util';

import { AuthError, authErrors } from '../errors';

import { parseFormField, getFullURL } from './helpers';
import { CookieJar, fetchCookieFollowRedirectsDecorator } from '../utils/fetch-cookie';
import { DESKTOP_USER_AGENT, CALLBACK_BLANK, captchaTypes } from '../utils/constants';

const { load: cheerioLoad } = cheerio;

const { URL, URLSearchParams } = nodeUrl;
const { promisify } = nodeUtil;

const debug = createDebug('vk-io:auth:implicit-flow');

const {
	PAGE_BLOCKED,
	INVALID_PHONE_NUMBER,
	AUTHORIZATION_FAILED,
	FAILED_PASSED_CAPTCHA,
	MISSING_CAPTCHA_HANDLER,
	FAILED_PASSED_TWO_FACTOR,
	MISSING_TWO_FACTOR_HANDLER
} = authErrors;

/**
 * Blocked action
 *
 * @type {string}
 */
const ACTION_BLOCKED = 'act=blocked';

/**
 * Two-factor auth check action
 *
 * @type {string}
 */
const ACTION_AUTH_CODE = 'act=authcheck';

/**
 * Phone number check action
 *
 * @type {string}
 */
const ACTION_SECURITY_CODE = 'act=security';

/**
 * Number of two-factorial attempts
 *
 * @type {number}
 */
const TWO_FACTOR_ATTEMPTS = 3;

/**
 * Number of captcha attempts
 *
 * @type {number}
 */
const CAPTCHA_ATTEMPTS = 3;

export default class ImplicitFlow {
	/**
	 * Constructor
	 *
	 * @param {VK}     vk
	 * @param {Object} options
	 */
	constructor(vk, {
		app = vk.options.app,
		key = vk.options.key,

		agent = vk.options.agent,

		scope = vk.options.scope,
		login = vk.options.login,
		phone = vk.options.phone,
		password = vk.options.password
	} = {}) {
		this.vk = vk;

		this.app = app;
		this.key = key;

		this.agent = agent;

		this.scope = scope;
		this.login = login;
		this.phone = phone;
		this.password = password;

		this.jar = new CookieJar();

		this.started = false;

		this.captcha = null;
		this.captchaAttempts = 0;
		this.twoFactorAttempts = 0;
	}

	/**
	 * Returns custom tag
	 *
	 * @return {string}
	 */
	get [Symbol.toStringTag]() {
		return this.constructor.name;
	}

	/**
	 * Returns CookieJar
	 *
	 * @return {CookieJar}
	 */
	get cookieJar() {
		return this.jar;
	}

	/**
	 * Sets the CookieJar
	 *
	 * @param {CookieJar} jar
	 *
	 * @return {this}
	 */
	set cookieJar(jar) {
		this.jar = jar;
	}

	/**
	 * Returns cookie
	 *
	 * @return {Promise<Object>}
	 */
	async getCookies() {
		const { jar } = this;

		const getCookieString = promisify(jar.getCookieString).bind(jar);

		const [login, main] = await Promise.all([
			getCookieString('https://login.vk.com'),
			getCookieString('https://vk.com')
		]);

		return {
			'login.vk.com': login,
			'vk.com': main
		};
	}

	/**
	 * Executes the HTTP request
	 *
	 * @param {string} url
	 * @param {Object} options
	 *
	 * @return {Promise<Response>}
	 */
	fetch(url, options = {}) {
		const { agent } = this;

		const { headers = {} } = options;

		return this.fetchCookie(url, {
			...options,

			agent,
			compress: false,

			headers: {
				...headers,

				'User-Agent': DESKTOP_USER_AGENT
			}
		});
	}

	/**
	 * Runs authorization
	 *
	 * @return {Promise<Object>}
	 */
	// eslint-disable-next-line consistent-return
	async run() {
		if (this.started) {
			throw new AuthError({
				message: 'Authorization already started!',
				code: AUTHORIZATION_FAILED
			});
		}

		this.started = true;

		this.fetchCookie = fetchCookieFollowRedirectsDecorator(this.jar);

		debug('get permissions page');

		let response = await this.getPermissionsPage();

		const isProcessed = true;

		while (isProcessed) {
			const { url } = response;

			debug('URL', url);

			if (url.includes(CALLBACK_BLANK)) {
				return { response };
			}

			if (url.includes(ACTION_BLOCKED)) {
				debug('page blocked');

				throw new AuthError({
					message: 'Page blocked',
					code: PAGE_BLOCKED
				});
			}

			const $ = cheerioLoad(await response.text());

			if (url.includes(ACTION_AUTH_CODE)) {
				response = await this.processTwoFactorForm(response, $);

				continue;
			}

			if (url.includes(ACTION_SECURITY_CODE)) {
				response = await this.processSecurityForm(response, $);

				continue;
			}

			const $error = $('.box_error');
			const $service = $('.service_msg_warning');

			const isError = $error.length !== 0;

			if (this.captcha === null && (isError || $service.length !== 0)) {
				const errorText = isError
					? $error.text()
					: $service.text();

				throw new AuthError({
					message: `Auth form error: ${errorText}`,
					code: AUTHORIZATION_FAILED,
					pageHtml: $.html()
				});
			}

			if (this.captcha !== null) {
				this.captcha.reject(new AuthError({
					message: 'Incorrect captcha code',
					code: FAILED_PASSED_CAPTCHA,
					pageHtml: $.html()
				}));

				this.captcha = null;

				this.captchaAttempts += 1;
			}

			if (this.captchaAttempts > CAPTCHA_ATTEMPTS) {
				throw new AuthError({
					message: 'Maximum attempts passage captcha',
					code: FAILED_PASSED_CAPTCHA
				});
			}

			if ($('input[name="pass"]').length !== 0) {
				debug('authorization form');

				response = await this.processAuthForm(response, $);

				continue;
			}

			if (url.includes('act=')) {
				throw new AuthError({
					message: 'Unsupported authorization event',
					code: AUTHORIZATION_FAILED,
					pageHtml: $.html()
				});
			}

			debug('auth with login & pass complete');

			if ($('form').length !== 0) {
				const { action } = parseFormField($);

				debug('url grant access', action);

				response = await this.fetch(action, {
					method: 'POST'
				});
			} else {
				const script = $.html();
				const locations = script.match(/location\.href\s+=\s+"([^"]+)"/i);

				if (locations === null) {
					throw new AuthError({
						message: 'Could not log in',
						code: AUTHORIZATION_FAILED
					});
				}

				const location = locations[1].replace('&cancel=1', '');

				debug('url grant access', location);

				response = await this.fetch(location, {
					method: 'POST'
				});
			}
		}
	}

	/**
	 * Process form auth
	 *
	 * @param {Response} response
	 * @param {Cheerio}  $
	 *
	 * @return {Promise<Response>}
	 */
	async processAuthForm(response, $) {
		debug('process login handle');

		const { login, password, phone } = this;

		const { action, fields } = parseFormField($);

		fields.email = login || phone;
		fields.pass = password;

		if ('captcha_sid' in fields) {
			if (this.vk.captchaHandler === null) {
				throw new AuthError({
					message: 'Missing captcha handler',
					code: MISSING_CAPTCHA_HANDLER
				});
			}

			const src = $('.oauth_captcha').attr('src') || $('#captcha').attr('src');

			const payload = {
				type: captchaTypes.IMPLICIT_FLOW_AUTH,
				sid: fields.captcha_sid,
				src
			};

			await (new Promise((resolveCaptcha, rejectCaptcha) => {
				this.vk.captchaHandler(payload, key => (
					new Promise((resolve, reject) => {
						if (key instanceof Error) {
							rejectCaptcha(key);
							reject(key);

							return;
						}

						fields.captcha_key = key;

						this.captcha = { resolve, reject };

						resolveCaptcha();
					})
				));
			}));
		}

		debug('Fields', fields);

		const url = new URL(action);

		url.searchParams.set('utf8', 1);

		return await this.fetch(url, {
			method: 'POST',
			body: new URLSearchParams(fields)
		});
	}

	/**
	 * Process two-factor form
	 *
	 * @param {Response} response
	 * @param {Cheerio}  $
	 *
	 * @return {Promise<Response>}
	 */
	async processTwoFactorForm(response, $) {
		debug('process two-factor handle');

		if (this.vk.twoFactorHandler === null) {
			throw new AuthError({
				message: 'Missing two-factor handler',
				code: MISSING_TWO_FACTOR_HANDLER
			});
		}

		let isProcessed = true;

		while (this.twoFactorAttempts < TWO_FACTOR_ATTEMPTS && isProcessed) {
			// eslint-disable-next-line no-loop-func
			await (new Promise((resolve, reject) => {
				this.vk.twoFactorHandler({}, async (code) => {
					const { action, fields } = parseFormField($);

					fields.code = code;

					try {
						const url = getFullURL(action, response);

						response = await this.fetch(url, {
							method: 'POST',
							body: new URLSearchParams(fields)
						});
					} catch (error) {
						reject(error);

						throw error;
					}

					if (response.url.includes(ACTION_AUTH_CODE)) {
						resolve();

						throw new AuthError({
							message: 'Incorrect two-factor code',
							code: FAILED_PASSED_TWO_FACTOR,
							pageHtml: $.html()
						});
					}

					isProcessed = false;

					resolve();
				});
			}));

			this.twoFactorAttempts += 1;
		}

		if (this.twoFactorAttempts >= TWO_FACTOR_ATTEMPTS && isProcessed) {
			throw new AuthError({
				message: 'Failed passed two-factor authentication',
				code: FAILED_PASSED_TWO_FACTOR
			});
		}

		return response;
	}

	/**
	 * Process security form
	 *
	 * @param {Response} response
	 * @param {Cheerio}  $
	 *
	 * @return {Promise<Response>}
	 */
	async processSecurityForm(response, $) {
		debug('process security form');

		const { login, phone } = this;

		let number;
		if (phone !== null) {
			number = phone;
		} else if (login !== null && !login.includes('@')) {
			number = login;
		} else {
			throw new AuthError({
				message: 'Missing phone number in the phone or login field',
				code: INVALID_PHONE_NUMBER,
				pageHtml: $.html()
			});
		}

		if (typeof number === 'string') {
			number = number.trim().replace(/^(\+|00)/, '');
		}

		number = String(number);

		const $field = $('.field_prefix');

		const prefix = $field.first().text().trim().replace('+', '').length;
		const postfix = $field.last().text().trim().length;

		const { action, fields } = parseFormField($);

		fields.code = number.slice(prefix, number.length - postfix);

		const url = getFullURL(action, response);

		response = await this.fetch(url, {
			method: 'POST',
			body: new URLSearchParams(fields)
		});

		if (response.url.includes(ACTION_SECURITY_CODE)) {
			throw new AuthError({
				message: 'Invalid phone number',
				code: INVALID_PHONE_NUMBER,
				pageHtml: $.html()
			});
		}

		return response;
	}
}
