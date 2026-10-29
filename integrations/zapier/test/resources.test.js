/* globals describe, it, expect */
'use strict';

const { flatKeys } = require('./helpers');
const { outputFields, samples } = require('../lib/resources');

describe('samples and output fields', () => {
  it.each(Object.keys(outputFields))('labels every %s field the sample has, and no others', (resource) => {
    const labelled = outputFields[resource].map((field) => field.key).sort();
    expect(flatKeys(samples[resource]).sort()).toEqual(labelled);
  });
});
