/* Reference mitigation for the deliberately vulnerable decoder fixture.
 *
 * Differences from packages/core/src/review/__fixtures__/c-library-demo:
 *   - allocation size equals the logical copy size (no 16-bit truncation)
 *   - multiplication is overflow-checked before use
 * Deliberately vulnerable fixture is unchanged; this file exists only so the
 * counterexample demo can replay the same witness against a corrected build.
 */
#include "decoder.h"
#include <stdlib.h>
#include <string.h>

int decode_payload(const uint8_t *data, size_t size,
                   uint8_t **out, size_t *out_size) {
  if (data == NULL || out == NULL || out_size == NULL) return -1;
  if (size < 8) return -1;

  uint32_t count = (uint32_t)data[0]
                 | ((uint32_t)data[1] << 8)
                 | ((uint32_t)data[2] << 16)
                 | ((uint32_t)data[3] << 24);
  uint32_t element_size = (uint32_t)data[4]
                        | ((uint32_t)data[5] << 8)
                        | ((uint32_t)data[6] << 16)
                        | ((uint32_t)data[7] << 24);

  if (element_size != 0 && count > SIZE_MAX / element_size) return -1;
  size_t copy_size = (size_t)count * (size_t)element_size;
  size_t available = size - 8;

  if (copy_size > available) return -1;

  uint8_t *buf = (uint8_t *)malloc(copy_size == 0 ? 1 : copy_size);
  if (buf == NULL) return -2;

  memcpy(buf, data + 8, copy_size);
  *out = buf;
  *out_size = copy_size;
  return 0;
}
