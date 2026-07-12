import { describe, it, expect, vi } from 'vitest';
import { validateAddress, validateTrace } from './validator.js';

// A minimal fake `res` object that mimics enough of Express's API for these
// tests: chainable .status(), and a spy-able .json().
function makeRes() {
    const res = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
}

describe('validateAddress', () => {
    it('rejects an address that is too short', () => {
        const req = { params: { address: '0x123' } };
        const res = makeRes();
        const next = vi.fn();

        validateAddress(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'Invalid Ethereum contract address.' });
        expect(next).not.toHaveBeenCalled();
    });

    it('calls next() for a well-formed 40-hex-character address', () => {
        const req = { params: { address: '0x1111111254fb6c44bac0bed2854e76f90643097d' } };
        const res = makeRes();
        const next = vi.fn();

        validateAddress(req, res, next);

        expect(next).toHaveBeenCalledOnce();
        expect(res.status).not.toHaveBeenCalled();
    });
});

describe('validateTrace', () => {
    const validBody = {
        to: '0x1111111254fb6c44bac0bed2854e76f90643097d',
        data: '0xabc123',
        blockNumber: '18500000',
    };

    it('rejects when "to" is not a valid address', () => {
        const req = { body: { ...validBody, to: '0xNOTLONGENOUGH' } };
        const res = makeRes();
        const next = vi.fn();

        validateTrace(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'Invalid "to" address.' });
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects when "data" is not valid hex', () => {
        const req = { body: { ...validBody, data: 'not-hex-at-all' } };
        const res = makeRes();
        const next = vi.fn();

        validateTrace(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'Invalid "data" hex string.' });
        expect(next).not.toHaveBeenCalled();
    });

    it('calls next() when all three fields are valid', () => {
        const req = { body: validBody };
        const res = makeRes();
        const next = vi.fn();

        validateTrace(req, res, next);

        expect(next).toHaveBeenCalledOnce();
        expect(res.status).not.toHaveBeenCalled();
    });
});