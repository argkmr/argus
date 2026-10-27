package com.argus.apiclient.domain;

import java.util.ArrayList;
import java.util.List;

public class ApiEnvironmentDocument {
  public String format = "argus-api-environments";
  public int version = 1;
  public String updatedAt;
  public List<ApiEnvironment> environments = new ArrayList<>();
}
