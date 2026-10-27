package com.argus.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

// Exercise Boot's real static-resource auto-configuration, but not Argus services,
// background integrations, or a listening server. Assets come from frontend/out
// through the same Maven resources copy used by the packaged executable JAR.
@SpringBootTest(
    classes = StaticResourceMimeTypeTest.StaticApplication.class,
    webEnvironment = SpringBootTest.WebEnvironment.MOCK)
class StaticResourceMimeTypeTest {
  @Autowired WebApplicationContext context;

  @Test
  void servesPdfModulesWithBrowserCompatibleJavascriptMimeAndOriginalBytes() throws Exception {
    for (String file : List.of("pdf.mjs", "pdf.worker.mjs")) {
      assertStaticResource("/legacy/vendor/pdfjs/" + file, "text/javascript");
    }
  }

  @Test
  void servesPdfDecodersWithWasmMimeAndOriginalBinaryBytes() throws Exception {
    for (String file : List.of("qcms_bg.wasm", "jbig2.wasm", "openjpeg.wasm")) {
      byte[] bytes = assertStaticResource("/legacy/vendor/pdfjs/wasm/" + file, "application/wasm");
      assertThat(bytes).startsWith((byte) 0, (byte) 0x61, (byte) 0x73, (byte) 0x6d);
    }
  }

  private byte[] assertStaticResource(String route, String mediaType) throws Exception {
    var response =
        MockMvcBuilders.webAppContextSetup(context)
            .build()
            .perform(get(route))
            .andReturn()
            .getResponse();
    assertThat(response.getStatus()).isEqualTo(200);
    assertThat(response.getContentType()).isEqualTo(mediaType);
    byte[] expected = new ClassPathResource("static" + route).getContentAsByteArray();
    assertThat(response.getContentAsByteArray()).isEqualTo(expected);
    return expected;
  }

  @Configuration(proxyBeanMethods = false)
  @EnableAutoConfiguration
  static class StaticApplication {}
}
